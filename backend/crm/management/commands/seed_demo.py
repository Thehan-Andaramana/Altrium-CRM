from django.contrib.auth.hashers import make_password
from django.core.management.base import BaseCommand
from django.db import transaction

from crm.models import Company, Contact, Lead, User


class Command(BaseCommand):
    help = 'Seeds the database with demo CRM data (users, companies, contacts, leads).'

    @transaction.atomic
    def handle(self, *args, **options):
        rep1 = self._seed_user('rep1', User.Role.SALES_REP)
        mgr1 = self._seed_user('mgr1', User.Role.SALES_MANAGER)

        companies = self._seed_companies(rep1)
        contacts = self._seed_contacts(companies)
        self._seed_leads(companies, contacts, rep1, mgr1)

        self.stdout.write(self.style.SUCCESS('Demo data seeded.'))

    def _seed_user(self, username, role):
        user, created = User.objects.get_or_create(
            username=username,
            defaults={
                'role': role,
                'is_staff': True,
                'email': f'{username}@example.com',
                'password': make_password('password123'),
            },
        )
        if created:
            self.stdout.write(f'Created user "{username}"')
        return user

    def _seed_companies(self, rep1):
        specs = [
            ('Acme Corp', 'Manufacturing', 'https://acme.example.com', rep1),
            ('Globex Inc', 'Technology', 'https://globex.example.com', rep1),
            ('Initech', 'Software', 'https://initech.example.com', None),
            ('Umbrella Corp', 'Pharmaceuticals', 'https://umbrella.example.com', None),
            ('Stark Industries', 'Defense', 'https://stark.example.com', None),
            ('Wayne Enterprises', 'Conglomerate', 'https://wayne.example.com', None),
        ]
        companies = {}
        for name, industry, website, owner in specs:
            company, created = Company.objects.get_or_create(
                name=name,
                defaults={'industry': industry, 'website': website, 'owner': owner},
            )
            if created:
                self.stdout.write(f'Created company "{name}"')
            companies[name] = company
        return companies

    def _seed_contacts(self, companies):
        specs = [
            ('Acme Corp', 'Alice Anderson', 'alice.anderson@acme.example.com', '555-0101', 'Procurement Manager'),
            ('Acme Corp', 'Andy Baker', 'andy.baker@acme.example.com', '555-0102', 'CFO'),
            ('Globex Inc', 'Grace Green', 'grace.green@globex.example.com', '555-0201', 'IT Director'),
            ('Initech', 'Peter Gibbons', 'peter.gibbons@initech.example.com', '555-0301', 'Software Engineer'),
        ]
        contacts = {}
        for company_name, name, email, phone, job_title in specs:
            contact, created = Contact.objects.get_or_create(
                company=companies[company_name],
                email=email,
                defaults={'name': name, 'phone': phone, 'job_title': job_title},
            )
            if created:
                self.stdout.write(f'Created contact "{name}"')
            contacts[email] = contact
        return contacts

    def _seed_leads(self, companies, contacts, rep1, mgr1):
        specs = [
            ('Acme Corp', 'alice.anderson@acme.example.com', Lead.Status.HOT, rep1),
            ('Globex Inc', 'grace.green@globex.example.com', Lead.Status.COLD, rep1),
            ('Initech', 'peter.gibbons@initech.example.com', Lead.Status.HOT, mgr1),
        ]
        for company_name, contact_email, status, assigned_to in specs:
            lead, created = Lead.objects.get_or_create(
                company=companies[company_name],
                contact=contacts[contact_email],
                assigned_to=assigned_to,
                defaults={'status': status},
            )
            if created:
                self.stdout.write(f'Created lead for "{company_name}"')
