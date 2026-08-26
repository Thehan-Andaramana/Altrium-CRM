from datetime import timedelta

from django.contrib.auth.hashers import make_password
from django.core.management.base import BaseCommand
from django.db import transaction
from django.utils import timezone

from crm.models import ApprovalRequest, Company, Contact, Interaction, Lead, PhaseRequirement, User

DEMO_PASSWORD = 'testpass123'


class Command(BaseCommand):
    help = (
        'Seeds the database with demo CRM data (users, companies, contacts, leads, '
        'interactions, and one lead with a pending phase 1 sign-off request). '
        'Projects and their phase 1/2/3 requirements are never created directly here -- '
        'they come from Lead.save() auto-creating a Project, which in turn copies its '
        'PhaseRequirement rows from whatever RequirementTemplates are currently active.'
    )

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.counts = {
            'users': [0, 0],
            'companies': [0, 0],
            'contacts': [0, 0],
            'leads': [0, 0],
            'interactions': [0, 0],
            'phase_requirements': [0, 0],
            'approvals': [0, 0],
        }

    @transaction.atomic
    def handle(self, *args, **options):
        rep1, rep2, mgr1 = self._seed_users()
        self._seed_superuser()
        companies = self._seed_companies(rep1, rep2)
        contacts = self._seed_contacts(companies)
        leads = self._seed_leads(companies, contacts, rep1, rep2, mgr1)
        self._seed_interactions(leads, rep1, rep2, mgr1)
        self._seed_phase1_signoff(leads, mgr1)

        self._print_summary()

    def _track(self, bucket, created):
        self.counts[bucket][0 if created else 1] += 1

    # -- users ---------------------------------------------------------

    def _seed_users(self):
        specs = [
            ('rep1', User.Role.SALES_REP),
            ('rep2', User.Role.SALES_REP),
            ('mgr1', User.Role.SALES_MANAGER),
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
        return users['rep1'], users['rep2'], users['mgr1']

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

        # (company, contact, status, assigned_to, days_ago, has_interactions)
        # days_ago backdates last_activity_at only for leads with no RESPONDED
        # interactions (a RESPONDED interaction drives last_activity_at itself,
        # via Interaction.save(); NO_ANSWER/MISSED_CALL interactions don't
        # touch it, so a lead can have those and still be backdated here).
        specs = [
            ('Acme Corp', 'Alice Anderson', Lead.Status.HOT, rep1, 1, True),
            ('Globex Inc', 'Grace Green', Lead.Status.COLD, rep1, 22, False),
            ('Globex Inc', 'Gary Hughes', Lead.Status.HOT, rep1, 4, True),
            ('Initech', 'Peter Gibbons', Lead.Status.COLD, rep2, 27, False),
            ('Umbrella Corp', 'Uma Ramirez', Lead.Status.HOT, rep2, 2, True),
            ('Umbrella Corp', 'Ulric Novak', Lead.Status.COLD, rep2, 30, False),
            ('Stark Industries', 'Sam Okafor', Lead.Status.COLD, mgr1, 14, False),
            ('Wayne Enterprises', 'Wendy Park', Lead.Status.HOT, mgr1, 6, False),
            ('Wayne Enterprises', 'Will Turner', Lead.Status.COLD, mgr1, 9, False),
        ]

        leads = {}
        for company_name, contact_name, status, assigned_to, days_ago, has_interactions in specs:
            company = companies[company_name]
            contact = contacts[(company_name, contact_name)]
            lead, created = Lead.objects.get_or_create(
                company=company,
                contact=contact,
                defaults={'status': status, 'assigned_to': assigned_to},
            )
            self._track('leads', created)
            if created:
                self.stdout.write(f'Created lead for "{company_name}" / {contact_name} ({status})')
                if not has_interactions:
                    # Bypass last_activity_at's auto_now via update(), so the
                    # backdated value sticks instead of being reset to "now".
                    Lead.objects.filter(pk=lead.pk).update(last_activity_at=now - timedelta(days=days_ago))
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

    # -- phase 1 sign-off ----------------------------------------------------

    def _seed_phase1_signoff(self, leads, mgr1):
        # Gives the manager's approvals queue something to review: complete
        # every phase 1 requirement on one lead's (auto-created) project, then
        # raise the same PENDING sign-off request the "Request sign-off"
        # button in the UI would create.
        lead, _has_interactions = leads[('Acme Corp', 'Alice Anderson')]
        project = lead.project

        for requirement in project.requirements.filter(phase=1):
            if requirement.status == PhaseRequirement.Status.COMPLETED:
                self._track('phase_requirements', False)
                continue
            requirement.status = PhaseRequirement.Status.COMPLETED
            requirement.updated_by = lead.assigned_to
            if requirement.confirmation_authority == PhaseRequirement.ConfirmationAuthority.MANAGER:
                requirement.confirmed_by = mgr1
                requirement.confirmed_at = timezone.now()
            requirement.save()
            self._track('phase_requirements', True)

        approval, created = ApprovalRequest.objects.get_or_create(
            project=project,
            request_type=ApprovalRequest.RequestType.PHASE_1_SIGNOFF,
            status=ApprovalRequest.Status.PENDING,
            defaults={'requested_by': lead.assigned_to},
        )
        self._track('approvals', created)
        if created:
            self.stdout.write(f'Created PENDING phase 1 sign-off request for "{lead.company.name}"')

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
            'phase_requirements': 'Phase 1 requirements completed',
            'approvals': 'Approval requests',
        }
        for key, label in labels.items():
            created, existing = self.counts[key]
            self.stdout.write(f'  {label}: {created} created, {existing} already existed')
