from datetime import timedelta

from django.contrib.auth.hashers import make_password
from django.core.management.base import BaseCommand
from django.db import transaction
from django.utils import timezone

from crm.models import (
    ApprovalRequest, Company, Contact, Interaction, Lead, PhaseRequirement, Project, RequirementTemplate, User,
)
from crm.serializers import ProjectSerializer

DEMO_PASSWORD = 'testpass123'

# Duration/authority for the ten canonical RequirementTemplate rows the data
# migration seeds. Any other active template (e.g. one added by hand through
# the admin UI) just gets a phase-appropriate fallback duration below, since
# there's no principled label to map it to one of these.
TEMPLATE_CONFIG = {
    # label: (default_duration_days, confirmation_authority, client_facing)
    'Budget Proposal': (5, 'REP', False),
    'Client Proposal Confirmation': (7, 'MANAGER', True),
    'Requirement Discussion': (3, 'REP', False),
    'Contract Papers': (10, 'MANAGER', True),
    'Technical Specification': (10, 'REP', False),
    'Development Progress Review': (14, 'REP', False),
    'QA Sign-off': (21, 'REP', False),
    'Client Acceptance': (3, 'MANAGER', True),
    'Final Proposal Signature': (5, 'MANAGER', True),
    'Handover Note': (7, 'REP', False),
}
PHASE_FALLBACK_DURATION = {1: 6, 2: 14, 3: 5}


class Command(BaseCommand):
    help = (
        'Seeds the database with demo CRM data covering every state the UI needs to show: '
        'users of every role, companies/contacts/leads, mixed-outcome interactions, and one '
        'lead per project/phase state (awaiting sign-off, approved and advanced, an overdue '
        'task, an unconfirmed manager task, a not-applicable task) plus one archived company. '
        'Projects and their phase 1/2/3 requirements are never created directly here -- they '
        'come from Lead.save() auto-creating a Project, which in turn copies its '
        'PhaseRequirement rows from whatever RequirementTemplates are currently active, so '
        'template duration/authority is seeded first.'
    )

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.counts = {
            'users': [0, 0],
            'companies': [0, 0],
            'contacts': [0, 0],
            'leads': [0, 0],
            'interactions': [0, 0],
            'approvals': [0, 0],
        }

    @transaction.atomic
    def handle(self, *args, **options):
        self._seed_requirement_templates()
        rep1, rep2, mgr1, _ex1 = self._seed_users()
        self._seed_superuser()
        companies = self._seed_companies(rep1, rep2)
        contacts = self._seed_contacts(companies)
        leads = self._seed_leads(companies, contacts, rep1, rep2, mgr1)
        self._seed_interactions(leads, rep1, rep2, mgr1)
        self._seed_project_states(leads, mgr1)
        self._seed_archived_company(companies, mgr1)

        self._print_summary()

    def _track(self, bucket, created):
        self.counts[bucket][0 if created else 1] += 1

    # -- requirement templates ----------------------------------------------

    def _seed_requirement_templates(self):
        updated = 0
        for template in RequirementTemplate.objects.filter(is_active=True):
            config = TEMPLATE_CONFIG.get(template.label)
            if config:
                duration, authority, client_facing = config
            else:
                # Unrecognized template (not one of the ten canonical rows) --
                # still gets a duration so "all active templates" holds, but
                # its authority/client_facing is left alone rather than
                # guessed at.
                duration = PHASE_FALLBACK_DURATION.get(template.phase, 7)
                authority = template.confirmation_authority
                client_facing = template.client_facing

            changed = False
            if template.default_duration_days != duration:
                template.default_duration_days = duration
                changed = True
            if template.confirmation_authority != authority:
                template.confirmation_authority = authority
                changed = True
            if template.client_facing != client_facing:
                template.client_facing = client_facing
                changed = True
            if changed:
                template.save(update_fields=['default_duration_days', 'confirmation_authority', 'client_facing'])
                updated += 1
        if updated:
            self.stdout.write(f'Updated {updated} requirement template(s) with duration/authority.')

    # -- users ---------------------------------------------------------

    def _seed_users(self):
        specs = [
            ('rep1', User.Role.SALES_REP),
            ('rep2', User.Role.SALES_REP),
            ('mgr1', User.Role.SALES_MANAGER),
            ('ex1', User.Role.EXECUTIVE_MANAGER),
        ]
        users = {}
        for username, role in specs:
            user, created = User.objects.get_or_create(
                username=username,
                defaults={
                    'role': role,
                    'is_staff': True,
                    'email': f'{username}@example.com',
                    'password': make_password(DEMO_PASSWORD),
                },
            )
            self._track('users', created)
            if created:
                self.stdout.write(f'Created user "{username}" ({role})')
            users[username] = user
        return users['rep1'], users['rep2'], users['mgr1'], users['ex1']

    def _seed_superuser(self):
        user, created = User.objects.get_or_create(
            username='admin',
            defaults={
                'role': User.Role.SYSTEM_ADMIN,
                'is_staff': True,
                'is_superuser': True,
                'email': 'admin@example.com',
                'password': make_password(DEMO_PASSWORD),
            },
        )
        self._track('users', created)
        if created:
            self.stdout.write('Created superuser "admin"')
        return user

    # -- companies -------------------------------------------------------

    def _seed_companies(self, rep1, rep2):
        # Six companies, split between the two reps, with two left unassigned.
        specs = [
            ('Acme Corp', 'Manufacturing', 'https://acme.example.com', rep1),
            ('Globex Inc', 'Technology', 'https://globex.example.com', rep1),
            ('Initech', 'Software', 'https://initech.example.com', rep2),
            ('Umbrella Corp', 'Pharmaceuticals', 'https://umbrella.example.com', rep2),
            ('Stark Industries', 'Defense', 'https://stark.example.com', None),
            ('Wayne Enterprises', 'Conglomerate', 'https://wayne.example.com', None),
        ]
        companies = {}
        for name, industry, website, owner in specs:
            company, created = Company.objects.get_or_create(
                name=name,
                defaults={'industry': industry, 'website': website, 'owner': owner},
            )
            self._track('companies', created)
            if created:
                self.stdout.write(f'Created company "{name}"')
            companies[name] = company
        return companies

    # -- contacts ---------------------------------------------------------

    def _seed_contacts(self, companies):
        # Two contacts per company, keyed by (company, email) for idempotency.
        specs = {
            'Acme Corp': [
                ('Alice Anderson', '555-0101', 'Procurement Manager'),
                ('Andy Baker', '555-0102', 'CFO'),
            ],
            'Globex Inc': [
                ('Grace Green', '555-0201', 'IT Director'),
                ('Gary Hughes', '555-0202', 'VP Engineering'),
            ],
            'Initech': [
                ('Peter Gibbons', '555-0301', 'Software Engineer'),
                ('Ivy Chen', '555-0302', 'Office Manager'),
            ],
            'Umbrella Corp': [
                ('Uma Ramirez', '555-0401', 'Head of Research'),
                ('Ulric Novak', '555-0402', 'Procurement Lead'),
            ],
            'Stark Industries': [
                ('Sam Okafor', '555-0501', 'Operations Director'),
                ('Sofia Reyes', '555-0502', 'Supply Chain Manager'),
            ],
            'Wayne Enterprises': [
                ('Wendy Park', '555-0601', 'VP Finance'),
                ('Will Turner', '555-0602', 'IT Manager'),
            ],
        }
        contacts = {}
        for company_name, people in specs.items():
            company = companies[company_name]
            slug = company_name.lower().replace(' ', '')
            for name, phone, job_title in people:
                local_part = name.lower().replace(' ', '.')
                email = f'{local_part}@{slug}.example.com'
                contact, created = Contact.objects.get_or_create(
                    company=company,
                    email=email,
                    defaults={'name': name, 'phone': phone, 'job_title': job_title},
                )
                self._track('contacts', created)
                if created:
                    self.stdout.write(f'Created contact "{name}" ({company_name})')
                contacts[(company_name, name)] = contact
        return contacts

    # -- leads -------------------------------------------------------------

    def _seed_leads(self, companies, contacts, rep1, rep2, mgr1):
        # Creating a Lead here triggers Lead.save()'s auto-creation of its
        # Project (and that Project's save() auto-creates its PhaseRequirement
        # rows from whatever RequirementTemplates are currently active) --
        # nothing in this command ever creates a Project or PhaseRequirement
        # directly.
        now = timezone.now()

        # (company, contact, name, status, assigned_to, days_ago, has_interactions)
        # days_ago backdates last_activity_at only for leads with no RESPONDED
        # interactions (a RESPONDED interaction drives last_activity_at itself,
        # via Interaction.save(); NO_ANSWER/MISSED_CALL interactions don't
        # touch it, so a lead can have those and still be backdated here).
        # Both status and the backdated last_activity_at are re-applied on
        # every run (not just at creation) so the HOT/COLD/approaching-cold
        # mix stays correct relative to "now" no matter when this is re-run.
        specs = [
            ('Acme Corp', 'Alice Anderson', 'Acme Corp — Q3 renewal & pricing rollout',
             Lead.Status.HOT, rep1, 1, True),
            ('Globex Inc', 'Grace Green', 'Globex Inc — Network security audit',
             Lead.Status.COLD, rep1, 22, False),
            ('Globex Inc', 'Gary Hughes', 'Globex Inc — Engineering platform demo',
             Lead.Status.HOT, rep1, 4, True),
            ('Initech', 'Peter Gibbons', 'Initech — Support ticketing overhaul',
             Lead.Status.COLD, rep2, 27, False),
            ('Umbrella Corp', 'Uma Ramirez', 'Umbrella Corp — Research partnership pilot',
             Lead.Status.HOT, rep2, 2, True),
            ('Umbrella Corp', 'Ulric Novak', 'Umbrella Corp — Procurement platform upgrade',
             Lead.Status.COLD, rep2, 30, False),
            ('Stark Industries', 'Sam Okafor', 'Stark Industries — Supply chain modernization',
             Lead.Status.COLD, mgr1, 14, False),
            # 12 days ago sits inside the default 14-day cold_lead_days
            # window's last 3 days (11-14) -- the dashboard's "approaching
            # cold" bucket.
            ('Wayne Enterprises', 'Wendy Park', 'Wayne Enterprises — Q3 infrastructure upgrade',
             Lead.Status.HOT, mgr1, 12, False),
            ('Wayne Enterprises', 'Will Turner', 'Wayne Enterprises — IT helpdesk migration',
             Lead.Status.COLD, mgr1, 9, False),
        ]

        leads = {}
        for company_name, contact_name, name, lead_status, assigned_to, days_ago, has_interactions in specs:
            company = companies[company_name]
            contact = contacts[(company_name, contact_name)]
            lead, created = Lead.objects.get_or_create(
                company=company,
                contact=contact,
                defaults={'name': name, 'status': lead_status, 'assigned_to': assigned_to},
            )
            self._track('leads', created)
            if created:
                self.stdout.write(f'Created lead "{name}"')

            update_fields = {'status': lead_status}
            if not has_interactions:
                update_fields['last_activity_at'] = now - timedelta(days=days_ago)
            Lead.objects.filter(pk=lead.pk).update(**update_fields)
            lead.refresh_from_db()

            leads[(company_name, contact_name)] = (lead, has_interactions)
        return leads

    # -- interactions ------------------------------------------------------

    def _seed_interactions(self, leads, rep1, rep2, mgr1):
        now = timezone.now()

        # (company, contact, type, outcome, notes, days_ago, created_by)
        specs = [
            ('Acme Corp', 'Alice Anderson', Interaction.Type.CALL, Interaction.Outcome.RESPONDED,
             'Introductory call, interested in Q3 renewal.', 6, rep1),
            ('Acme Corp', 'Alice Anderson', Interaction.Type.EMAIL, Interaction.Outcome.RESPONDED,
             'Sent updated pricing sheet.', 1, rep1),
            ('Globex Inc', 'Gary Hughes', Interaction.Type.MEETING, Interaction.Outcome.RESPONDED,
             'Demo with the engineering team.', 4, rep1),
            ('Globex Inc', 'Grace Green', Interaction.Type.CALL, Interaction.Outcome.NO_ANSWER,
             'Tried to follow up on the proposal; no answer.', 10, rep1),
            ('Initech', 'Peter Gibbons', Interaction.Type.CALL, Interaction.Outcome.MISSED_CALL,
             'Callback attempt after the initial demo.', 15, rep2),
            ('Umbrella Corp', 'Uma Ramirez', Interaction.Type.CALL, Interaction.Outcome.RESPONDED,
             'Discussed research partnership scope.', 5, rep2),
            ('Umbrella Corp', 'Uma Ramirez', Interaction.Type.NOTE, Interaction.Outcome.RESPONDED,
             'Follow up after budget approval next quarter.', 2, rep2),
            ('Umbrella Corp', 'Ulric Novak', Interaction.Type.CALL, Interaction.Outcome.NO_ANSWER,
             'Left a voicemail about the procurement upgrade.', 8, rep2),
            ('Wayne Enterprises', 'Will Turner', Interaction.Type.CALL, Interaction.Outcome.MISSED_CALL,
             'Tried to catch him about the helpdesk migration.', 3, mgr1),
        ]

        for company_name, contact_name, itype, outcome, notes, days_ago, created_by in specs:
            lead, _has_interactions = leads[(company_name, contact_name)]
            interaction, created = Interaction.objects.get_or_create(
                lead=lead,
                type=itype,
                notes=notes,
                defaults={
                    'outcome': outcome,
                    'occurred_at': now - timedelta(days=days_ago),
                    'created_by': created_by,
                },
            )
            self._track('interactions', created)
            if created:
                self.stdout.write(f'Created interaction ({itype}/{outcome}) on "{company_name}" / {contact_name}')

    # -- project/phase/task states -------------------------------------------

    def _backdate_phase_start(self, project, phase_num, days_ago):
        # Mirrors Project.start_phase()'s due-date math, but against a
        # backdated start instead of "now" -- so an already-started phase's
        # due dates land in the past instead of the future.
        started_at = timezone.now() - timedelta(days=days_ago)
        start_date = started_at.date()
        field_name = Project.PHASE_STARTED_AT_FIELDS[phase_num]
        Project.objects.filter(pk=project.pk).update(**{field_name: started_at})

        to_update = []
        for requirement in project.requirements.filter(phase=phase_num):
            if requirement.default_duration_days is None:
                continue
            requirement.due_date = start_date + timedelta(days=requirement.default_duration_days)
            to_update.append(requirement)
        if to_update:
            PhaseRequirement.objects.bulk_update(to_update, ['due_date'])

    def _seed_project_states(self, leads, mgr1):
        self._seed_awaiting_signoff(leads, mgr1)
        self._seed_completed_and_approved_phase(leads, mgr1)
        self._seed_overdue_task(leads)
        self._seed_unconfirmed_manager_task(leads)
        self._seed_not_applicable_task(leads)

    def _complete_phase_1_requirements(self, project, actor, mgr1):
        for requirement in project.requirements.filter(phase=1):
            if requirement.status == PhaseRequirement.Status.COMPLETED:
                continue
            requirement.status = PhaseRequirement.Status.COMPLETED
            requirement.updated_by = actor
            if requirement.confirmation_authority == PhaseRequirement.ConfirmationAuthority.MANAGER:
                requirement.confirmed_by = mgr1
                requirement.confirmed_at = timezone.now()
            requirement.save()

    def _seed_awaiting_signoff(self, leads, mgr1):
        # Phase 1 at 100% with a still-PENDING sign-off request -- the amber
        # "Awaiting Approval" state.
        lead, _has_interactions = leads[('Acme Corp', 'Alice Anderson')]
        project = lead.project
        self._complete_phase_1_requirements(project, lead.assigned_to, mgr1)
        if project.phase_1_status != Project.PhaseStatus.AWAITING_APPROVAL:
            Project.objects.filter(pk=project.pk).update(phase_1_status=Project.PhaseStatus.AWAITING_APPROVAL)

        approval, created = ApprovalRequest.objects.get_or_create(
            project=project,
            request_type=ApprovalRequest.RequestType.PHASE_1_SIGNOFF,
            status=ApprovalRequest.Status.PENDING,
            defaults={'requested_by': lead.assigned_to},
        )
        self._track('approvals', created)
        if created:
            self.stdout.write(f'Created PENDING phase 1 sign-off request for "{lead.name}"')

    def _seed_completed_and_approved_phase(self, leads, mgr1):
        # Phase 1 complete with an APPROVED sign-off -- phase 2 auto-advances
        # to IN_PROGRESS and renders green.
        lead, _has_interactions = leads[('Globex Inc', 'Grace Green')]
        project = lead.project
        project.refresh_from_db()
        if project.phase_1_status == Project.PhaseStatus.COMPLETE:
            return

        self._backdate_phase_start(project, 1, days_ago=20)
        project.refresh_from_db()
        self._complete_phase_1_requirements(project, lead.assigned_to, mgr1)

        approval, _created = ApprovalRequest.objects.get_or_create(
            project=project,
            request_type=ApprovalRequest.RequestType.PHASE_1_SIGNOFF,
            defaults={
                'requested_by': lead.assigned_to,
                'status': ApprovalRequest.Status.APPROVED,
                'decided_by': mgr1,
                'decided_at': timezone.now(),
            },
        )
        if approval.status != ApprovalRequest.Status.APPROVED:
            approval.status = ApprovalRequest.Status.APPROVED
            approval.decided_by = mgr1
            approval.decided_at = timezone.now()
            approval.save()
        self._track('approvals', _created)

        ProjectSerializer.complete_phase(project, 1)
        self.stdout.write(f'Completed and approved phase 1 for "{lead.name}" -- phase 2 now active.')

    def _seed_overdue_task(self, leads):
        # A phase 1 task whose due date is well in the past -- the red
        # overdue bar and the dashboard's overdue-tasks card.
        lead, _has_interactions = leads[('Initech', 'Peter Gibbons')]
        project = lead.project
        requirement = project.requirements.filter(phase=1, label='Budget Proposal').first()
        if requirement is None:
            return
        if requirement.default_duration_days is None:
            requirement.default_duration_days = 5
            requirement.save(update_fields=['default_duration_days'])
        self._backdate_phase_start(project, 1, days_ago=25)
        self.stdout.write(f'Backdated phase 1 on "{lead.name}" so "{requirement.label}" is overdue.')

    def _seed_unconfirmed_manager_task(self, leads):
        # A MANAGER-authority task marked COMPLETED but never confirmed --
        # the amber "awaiting confirmation" clock state.
        lead, _has_interactions = leads[('Umbrella Corp', 'Ulric Novak')]
        requirement = lead.project.requirements.filter(phase=1, label='Client Proposal Confirmation').first()
        if requirement is None:
            return
        requirement.confirmation_authority = PhaseRequirement.ConfirmationAuthority.MANAGER
        requirement.status = PhaseRequirement.Status.COMPLETED
        requirement.updated_by = lead.assigned_to
        requirement.confirmed_by = None
        requirement.confirmed_at = None
        requirement.save()

    def _seed_not_applicable_task(self, leads):
        lead, _has_interactions = leads[('Wayne Enterprises', 'Wendy Park')]
        requirement = lead.project.requirements.filter(phase=1, label='Requirement Discussion').first()
        if requirement is None:
            return
        requirement.status = PhaseRequirement.Status.NOT_APPLICABLE
        requirement.updated_by = lead.assigned_to
        requirement.save()

    # -- archived company -----------------------------------------------------

    def _seed_archived_company(self, companies, mgr1):
        company = companies['Stark Industries']
        company.refresh_from_db()
        if company.is_archived:
            return

        now = timezone.now()
        reason = 'Client paused the engagement indefinitely.'
        company.is_archived = True
        company.archived_by = mgr1
        company.archived_at = now
        company.archive_reason = reason
        company.save(update_fields=['is_archived', 'archived_by', 'archived_at', 'archive_reason'])

        cascade_reason = f'Cascaded from company archive: {reason}'
        company.leads.filter(is_archived=False).update(
            is_archived=True, archived_by=mgr1, archived_at=now, archive_reason=cascade_reason,
        )
        company.projects.filter(is_archived=False).update(
            is_archived=True, archived_by=mgr1, archived_at=now, archive_reason=cascade_reason,
        )
        self.stdout.write(f'Archived company "{company.name}" (cascaded to its leads/projects).')

    # -- summary -------------------------------------------------------------

    def _print_summary(self):
        self.stdout.write('')
        self.stdout.write(self.style.SUCCESS('Summary:'))
        labels = {
            'users': 'Users',
            'companies': 'Companies',
            'contacts': 'Contacts',
            'leads': 'Leads',
            'interactions': 'Interactions',
            'approvals': 'Approval requests',
        }
        for key, label in labels.items():
            created, existing = self.counts[key]
            self.stdout.write(f'  {label}: {created} created, {existing} already existed')
