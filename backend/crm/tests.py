from decimal import Decimal

from django.db import IntegrityError, transaction
from django.test import TestCase
from rest_framework import status
from rest_framework.reverse import reverse
from rest_framework.test import APIClient, APITestCase

from .models import ApprovalRequest, Company, Contact, Deal, Lead, Project, User


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


class ApprovalRequestPermissionTests(APITestCase):
    def setUp(self):
        self.rep = User.objects.create_user(username='rep', password='pass', role=User.Role.SALES_REP)
        self.other_manager = User.objects.create_user(username='mgr2', password='pass', role=User.Role.SALES_MANAGER)
        self.manager = User.objects.create_user(username='mgr', password='pass', role=User.Role.SALES_MANAGER)
        self.company = Company.objects.create(name='Acme', owner=self.rep)
        self.lead = Lead.objects.create(company=self.company, assigned_to=self.rep, status=Lead.Status.HOT)

    def test_rep_cannot_approve_own_request(self):
        approval = ApprovalRequest.objects.create(
            request_type=ApprovalRequest.RequestType.ARCHIVE_LEAD,
            lead=self.lead,
            requested_by=self.rep,
        )
        self.client.force_authenticate(self.rep)
        url = reverse('approvalrequest-detail', args=[approval.id])
        response = self.client.patch(url, {'status': ApprovalRequest.Status.APPROVED}, format='json')
        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)
        approval.refresh_from_db()
        self.assertEqual(approval.status, ApprovalRequest.Status.PENDING)

    def test_manager_cannot_approve_own_request(self):
        # A management role is normally allowed to decide requests -- but not
        # one they submitted themselves.
        approval = ApprovalRequest.objects.create(
            request_type=ApprovalRequest.RequestType.ARCHIVE_LEAD,
            lead=self.lead,
            requested_by=self.manager,
        )
        self.client.force_authenticate(self.manager)
        url = reverse('approvalrequest-detail', args=[approval.id])
        response = self.client.patch(url, {'status': ApprovalRequest.Status.APPROVED}, format='json')
        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)
        approval.refresh_from_db()
        self.assertEqual(approval.status, ApprovalRequest.Status.PENDING)

        # A *different* manager deciding that same request is fine, which
        # confirms the block above is about identity, not role.
        self.client.force_authenticate(self.other_manager)
        response = self.client.patch(url, {'status': ApprovalRequest.Status.APPROVED}, format='json')
        self.assertEqual(response.status_code, status.HTTP_200_OK)

    def test_manager_can_approve_another_users_request_and_stamps_decision(self):
        approval = ApprovalRequest.objects.create(
            request_type=ApprovalRequest.RequestType.ARCHIVE_LEAD,
            lead=self.lead,
            requested_by=self.rep,
        )
        self.client.force_authenticate(self.manager)
        url = reverse('approvalrequest-detail', args=[approval.id])
        response = self.client.patch(url, {'status': ApprovalRequest.Status.APPROVED}, format='json')
        self.assertEqual(response.status_code, status.HTTP_200_OK)

        approval.refresh_from_db()
        self.assertEqual(approval.status, ApprovalRequest.Status.APPROVED)
        self.assertEqual(approval.decided_by, self.manager)
        self.assertIsNotNone(approval.decided_at)


class ApprovalRequestConstraintTests(TestCase):
    def setUp(self):
        self.rep = User.objects.create_user(username='rep', password='pass', role=User.Role.SALES_REP)
        self.company = Company.objects.create(name='Acme', owner=self.rep)
        self.lead = Lead.objects.create(company=self.company, assigned_to=self.rep)
        self.contact = Contact.objects.create(company=self.company, name='Jane Doe')
        self.deal = Deal.objects.create(company=self.company, contact=self.contact, value=1000, assigned_to=self.rep)
        self.project = Project.objects.create(company=self.company, deal=self.deal)

    def test_rejects_both_lead_and_project_set(self):
        with self.assertRaises(IntegrityError), transaction.atomic():
            ApprovalRequest.objects.create(
                request_type=ApprovalRequest.RequestType.ARCHIVE_LEAD,
                lead=self.lead,
                project=self.project,
                requested_by=self.rep,
            )

    def test_rejects_neither_lead_nor_project_set(self):
        with self.assertRaises(IntegrityError), transaction.atomic():
            ApprovalRequest.objects.create(
                request_type=ApprovalRequest.RequestType.ARCHIVE_LEAD,
                requested_by=self.rep,
            )


class ProjectPhaseTransitionTests(APITestCase):
    def setUp(self):
        self.rep = User.objects.create_user(username='rep', password='pass', role=User.Role.SALES_REP)
        self.manager = User.objects.create_user(username='mgr', password='pass', role=User.Role.SALES_MANAGER)
        self.company = Company.objects.create(name='Acme', owner=self.rep)
        self.contact = Contact.objects.create(company=self.company, name='Jane Doe')
        self.deal = Deal.objects.create(
            company=self.company, contact=self.contact, value=Decimal('1000.00'), assigned_to=self.rep,
        )
        self.project = Project.objects.create(company=self.company, deal=self.deal)
        self.client.force_authenticate(self.manager)

    def _approve_signoff(self, request_type):
        approval = ApprovalRequest.objects.create(
            request_type=request_type,
            project=self.project,
            requested_by=self.rep,
        )
        url = reverse('approvalrequest-detail', args=[approval.id])
        response = self.client.patch(url, {'status': ApprovalRequest.Status.APPROVED}, format='json')
        self.assertEqual(response.status_code, status.HTTP_200_OK)

    def _patch_project(self, **fields):
        url = reverse('project-detail', args=[self.project.id])
        return self.client.patch(url, fields, format='json')

    def test_phase_2_cannot_start_while_phase_1_incomplete(self):
        response = self._patch_project(phase_2_status=Project.PhaseStatus.IN_PROGRESS)
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.project.refresh_from_db()
        self.assertEqual(self.project.phase_2_status, Project.PhaseStatus.NOT_STARTED)

    def test_phase_cannot_complete_without_approved_signoff(self):
        response = self._patch_project(phase_1_status=Project.PhaseStatus.COMPLETE)
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.project.refresh_from_db()
        self.assertEqual(self.project.phase_1_status, Project.PhaseStatus.NOT_STARTED)

    def test_maintenance_flips_true_once_all_phases_complete(self):
        self._approve_signoff(ApprovalRequest.RequestType.PHASE_1_SIGNOFF)
        response = self._patch_project(phase_1_status=Project.PhaseStatus.COMPLETE)
        self.assertEqual(response.status_code, status.HTTP_200_OK)

        response = self._patch_project(phase_2_status=Project.PhaseStatus.IN_PROGRESS)
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self._approve_signoff(ApprovalRequest.RequestType.PHASE_2_SIGNOFF)
        response = self._patch_project(phase_2_status=Project.PhaseStatus.COMPLETE)
        self.assertEqual(response.status_code, status.HTTP_200_OK)

        response = self._patch_project(phase_3_status=Project.PhaseStatus.IN_PROGRESS)
        self.assertEqual(response.status_code, status.HTTP_200_OK)

        self.project.refresh_from_db()
        self.assertFalse(self.project.maintenance)

        self._approve_signoff(ApprovalRequest.RequestType.PHASE_3_SIGNOFF)
        response = self._patch_project(phase_3_status=Project.PhaseStatus.COMPLETE)
        self.assertEqual(response.status_code, status.HTTP_200_OK)

        self.project.refresh_from_db()
        self.assertTrue(self.project.maintenance)


class DashboardScopingTests(APITestCase):
    def setUp(self):
        self.rep1 = User.objects.create_user(username='rep1', password='pass', role=User.Role.SALES_REP)
        self.rep2 = User.objects.create_user(username='rep2', password='pass', role=User.Role.SALES_REP)
        self.manager = User.objects.create_user(username='mgr', password='pass', role=User.Role.SALES_MANAGER)

        self.company1 = Company.objects.create(name='Rep1 Co', owner=self.rep1)
        self.company2 = Company.objects.create(name='Rep2 Co', owner=self.rep2)
        self.lead1 = Lead.objects.create(company=self.company1, assigned_to=self.rep1, status=Lead.Status.HOT)
        self.lead2 = Lead.objects.create(company=self.company2, assigned_to=self.rep2, status=Lead.Status.HOT)

    def _lead_ids(self, data):
        ids = set()
        for group in ('hot_leads', 'cold_leads', 'approaching_cold_leads'):
            ids.update(row['id'] for row in data[group]['results'])
        return ids

    def test_rep_sees_only_their_own_leads(self):
        self.client.force_authenticate(self.rep1)
        response = self.client.get(reverse('dashboard'))
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        ids = self._lead_ids(response.data)
        self.assertIn(self.lead1.id, ids)
        self.assertNotIn(self.lead2.id, ids)

    def test_manager_sees_all_leads(self):
        self.client.force_authenticate(self.manager)
        response = self.client.get(reverse('dashboard'))
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        ids = self._lead_ids(response.data)
        self.assertIn(self.lead1.id, ids)
        self.assertIn(self.lead2.id, ids)
