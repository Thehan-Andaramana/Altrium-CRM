from django.conf import settings
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction
from django.db.models import Q

from crm.models import ApprovalRequest, Company, Lead, PhaseRequirement, RequirementTemplate

# What the Playwright fixtures stamp into every name they generate (see
# e2e/helpers.js). Anything carrying it was created by a test run.
E2E_MARKER = '[e2e]'

# Fixture names from before the marker existed. Kept because the records
# they made are exactly what this command was written to clear out, and
# they will stay in a developer's database until something removes them.
# Each is anchored to the start of the name, so a real company called
# "Shotwell Industries" is not swept up by "Shot ".
LEGACY_COMPANY_PREFIXES = ('E2E Co ', 'Lifecycle Co ', 'Shot Co ')
LEGACY_LEAD_PREFIXES = ('E2E Lead ', 'Lifecycle Lead ', 'Shot Lead ')
LEGACY_TEMPLATE_PREFIXES = ('E2E Template ', 'Copy Me ', 'Retire Me ')


def _matcher(prefixes):
    """A Q matching the marker anywhere, or any of the legacy prefixes."""
    query = Q(name__contains=E2E_MARKER)
    for prefix in prefixes:
        query |= Q(name__startswith=prefix)
    return query


def _template_matcher():
    query = Q(label__contains=E2E_MARKER)
    for prefix in LEGACY_TEMPLATE_PREFIXES:
        query |= Q(label__startswith=prefix)
    return query


class Command(BaseCommand):
    help = (
        'Delete the records left behind by Playwright runs: the companies the fixtures create '
        '(and everything that cascades from them -- leads, projects, tasks, approvals, '
        'interactions, activity) plus any requirement templates a spec made. '
        'Identified by the "[e2e]" marker in their name, or by the fixture name prefixes used '
        'before that marker existed. Refuses to run outside DEBUG without --force.'
    )

    def add_arguments(self, parser):
        parser.add_argument(
            '--dry-run',
            action='store_true',
            help='Report what would be deleted and change nothing.',
        )
        parser.add_argument(
            '--yes',
            action='store_true',
            help='Skip the confirmation prompt.',
        )
        parser.add_argument(
            '--force',
            action='store_true',
            help='Allow running with DEBUG off. This deletes real rows -- be sure.',
        )

    def handle(self, *args, **options):
        if not settings.DEBUG and not options['force']:
            raise CommandError(
                'DEBUG is off, so this looks like a real deployment. '
                'Re-run with --force if you are certain this database holds test records.',
            )

        companies = Company.objects.filter(_matcher(LEGACY_COMPANY_PREFIXES))
        # A lead whose company is being removed goes with it; this catches
        # any created against a company that isn't itself a fixture.
        leads = Lead.objects.filter(_matcher(LEGACY_LEAD_PREFIXES)).exclude(company__in=companies)
        templates = RequirementTemplate.objects.filter(_template_matcher())

        counts = self._describe(companies, leads, templates)
        total = sum(counts.values())

        if total == 0:
            self.stdout.write(self.style.SUCCESS('Nothing to purge -- no e2e records found.'))
            return

        for label, count in counts.items():
            self.stdout.write(f'  {count:>6}  {label}')

        if options['dry_run']:
            self.stdout.write(self.style.WARNING('Dry run -- nothing deleted.'))
            return

        if not options['yes']:
            answer = input(f'Delete these {total} records? [y/N] ')
            if answer.strip().lower() not in ('y', 'yes'):
                self.stdout.write('Cancelled.')
                return

        with transaction.atomic():
            # Tasks generated from a fixture template first: PhaseRequirement
            # .template is SET_NULL, so deleting the template alone would
            # leave those tasks behind on real projects with no template.
            PhaseRequirement.objects.filter(template__in=templates).delete()
            templates.delete()
            leads.delete()
            companies.delete()

        self.stdout.write(self.style.SUCCESS(f'Purged {total} e2e records.'))

    def _describe(self, companies, leads, templates):
        """
        What is about to go. Counted through the same cascade the delete
        follows, so the number reported is the number removed.
        """
        company_ids = list(companies.values_list('id', flat=True))
        lead_ids = list(
            Lead.objects.filter(Q(company_id__in=company_ids) | Q(id__in=leads.values('id')))
            .values_list('id', flat=True)
        )

        return {
            'companies': len(company_ids),
            'leads': len(lead_ids),
            'projects': Lead.objects.filter(id__in=lead_ids, project__isnull=False).count(),
            'phase requirements': PhaseRequirement.objects.filter(project__lead_id__in=lead_ids).count(),
            'approval requests': ApprovalRequest.objects.filter(
                Q(lead_id__in=lead_ids) | Q(project__lead_id__in=lead_ids),
            ).count(),
            'requirement templates': templates.count(),
        }
