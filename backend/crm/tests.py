from django.test import TestCase
from rest_framework import status
from rest_framework.reverse import reverse
from rest_framework.test import APIClient

from .models import Company, Contact, Deal, Lead, User


class CompanyOwnerPermissionTests(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.rep = User.objects.create_user(username='rep', password='pass', role=User.Role.SALES_REP)
        self.other_user = User.objects.create_user(username='other', password='pass', role=User.Role.SALES_REP)
        self.manager = User.objects.create_user(username='mgr', password='pass', role=User.Role.SALES_MANAGER)
        self.company = Company.objects.create(name='Acme', owner=self.rep)

    def test_sales_rep_cannot_change_owner(self):
        self.client.force_authenticate(self.rep)
        url = reverse('company-detail', args=[self.company.id])
        response = self.client.patch(url, {'owner': self.other_user.id}, format='json')
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.company.refresh_from_db()
        self.assertEqual(self.company.owner, self.rep)

    def test_sales_manager_can_change_owner(self):
        self.client.force_authenticate(self.manager)
        url = reverse('company-detail', args=[self.company.id])
        response = self.client.patch(url, {'owner': self.other_user.id}, format='json')
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.company.refresh_from_db()
        self.assertEqual(self.company.owner, self.other_user)


class CompanyOwnerReassignmentCascadeTests(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.rep = User.objects.create_user(username='rep', password='pass', role=User.Role.SALES_REP)
        self.new_owner = User.objects.create_user(username='newowner', password='pass', role=User.Role.SALES_REP)
        self.manager = User.objects.create_user(username='mgr', password='pass', role=User.Role.SALES_MANAGER)
        self.company = Company.objects.create(name='Acme', owner=self.rep)
        self.contact = Contact.objects.create(company=self.company, name='Jane Doe')
        self.lead = Lead.objects.create(company=self.company, contact=self.contact, assigned_to=self.rep)
        self.open_deal = Deal.objects.create(
            company=self.company,
            contact=self.contact,
            stage=Deal.Stage.NEW_LEAD,
            value=1000,
            assigned_to=self.rep,
        )
        self.closed_deal = Deal.objects.create(
            company=self.company,
            contact=self.contact,
            stage=Deal.Stage.CLOSED_WON,
            value=5000,
            assigned_to=self.rep,
        )

    def test_reassigning_owner_cascades_to_leads_and_deals(self):
        self.client.force_authenticate(self.manager)
        url = reverse('company-detail', args=[self.company.id])
        response = self.client.patch(url, {'owner': self.new_owner.id}, format='json')
        self.assertEqual(response.status_code, status.HTTP_200_OK)

        self.lead.refresh_from_db()
        self.open_deal.refresh_from_db()
        self.closed_deal.refresh_from_db()

        self.assertEqual(self.lead.assigned_to, self.new_owner)
        self.assertEqual(self.open_deal.assigned_to, self.new_owner)
        self.assertEqual(self.closed_deal.assigned_to, self.new_owner)
