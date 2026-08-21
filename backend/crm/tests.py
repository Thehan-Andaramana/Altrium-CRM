import shutil
import tempfile
from decimal import Decimal

from django.conf import settings
from django.core.files.uploadedfile import SimpleUploadedFile
from django.db import IntegrityError, transaction
from django.test import TestCase, override_settings
from rest_framework import status
from rest_framework.reverse import reverse
from rest_framework.test import APIClient, APITestCase

from .models import ApprovalRequest, Company, Contact, Deal, Interaction, Lead, PhaseRequirement, Project, User


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

    def test_rejects_second_pending_request_for_same_project_and_type(self):
        ApprovalRequest.objects.create(
            request_type=ApprovalRequest.RequestType.PHASE_1_SIGNOFF,
            project=self.project,
            requested_by=self.rep,
        )
        with self.assertRaises(IntegrityError), transaction.atomic():
            ApprovalRequest.objects.create(
                request_type=ApprovalRequest.RequestType.PHASE_1_SIGNOFF,
                project=self.project,
                requested_by=self.rep,
            )

    def test_allows_second_request_once_first_is_decided(self):
        first = ApprovalRequest.objects.create(
            request_type=ApprovalRequest.RequestType.PHASE_1_SIGNOFF,
            project=self.project,
            requested_by=self.rep,
        )
        first.status = ApprovalRequest.Status.REJECTED
        first.save()

        second = ApprovalRequest.objects.create(
            request_type=ApprovalRequest.RequestType.PHASE_1_SIGNOFF,
            project=self.project,
            requested_by=self.rep,
        )
        self.assertIsNotNone(second.pk)


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


class ProjectRequirementsTestMixin:
    def setUp(self):
        self.manager = User.objects.create_user(username='mgr', password='pass', role=User.Role.SALES_MANAGER)
        self.rep = User.objects.create_user(username='rep', password='pass', role=User.Role.SALES_REP)
        self.company = Company.objects.create(name='Acme', owner=self.rep)
        self.contact = Contact.objects.create(company=self.company, name='Jane Doe')
        self.deal = Deal.objects.create(
            company=self.company, contact=self.contact, value=Decimal('1000.00'), assigned_to=self.rep,
        )
        self.project = Project.objects.create(company=self.company, deal=self.deal)
        self.client.force_authenticate(self.manager)


class ProjectProgressTests(ProjectRequirementsTestMixin, APITestCase):
    def test_default_requirements_are_generated_on_creation(self):
        self.assertEqual(self.project.requirements.filter(phase=1).count(), 4)
        self.assertEqual(self.project.requirements.filter(phase=2).count(), 3)
        self.assertEqual(self.project.requirements.filter(phase=3).count(), 3)

    def test_phase_progress_and_overall_progress(self):
        url = reverse('project-detail', args=[self.project.id])
        response = self.client.get(url)
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.data['phase_progress'][1], {'completed': 0, 'total': 4, 'percent': 0})
        self.assertEqual(response.data['phase_progress'][2], {'completed': 0, 'total': 3, 'percent': 0})
        self.assertEqual(response.data['phase_progress'][3], {'completed': 0, 'total': 3, 'percent': 0})
        self.assertEqual(response.data['overall_progress'], 0)

        phase1_ids = list(self.project.requirements.filter(phase=1).values_list('id', flat=True))[:2]
        PhaseRequirement.objects.filter(pk__in=phase1_ids).update(is_complete=True)

        response = self.client.get(url)
        self.assertEqual(response.data['phase_progress'][1], {'completed': 2, 'total': 4, 'percent': 50})
        # 2 of the project's 10 total requirements are complete.
        self.assertEqual(response.data['overall_progress'], 20)


class ProjectRequirementGateTests(ProjectRequirementsTestMixin, APITestCase):
    def test_cannot_move_to_awaiting_approval_with_incomplete_requirements(self):
        url = reverse('project-detail', args=[self.project.id])
        response = self.client.patch(url, {'phase_1_status': Project.PhaseStatus.AWAITING_APPROVAL}, format='json')
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.project.refresh_from_db()
        self.assertEqual(self.project.phase_1_status, Project.PhaseStatus.NOT_STARTED)

    def test_can_move_to_awaiting_approval_once_all_requirements_complete(self):
        self.project.requirements.filter(phase=1).update(is_complete=True)
        url = reverse('project-detail', args=[self.project.id])
        response = self.client.patch(url, {'phase_1_status': Project.PhaseStatus.AWAITING_APPROVAL}, format='json')
        self.assertEqual(response.status_code, status.HTTP_200_OK)


class ApprovalRequestDuplicateApiTests(ProjectRequirementsTestMixin, APITestCase):
    def test_duplicate_pending_request_rejected_with_clear_error(self):
        url = reverse('approvalrequest-list')
        first = self.client.post(
            url, {'request_type': ApprovalRequest.RequestType.PHASE_1_SIGNOFF, 'project': self.project.id},
            format='json',
        )
        self.assertEqual(first.status_code, status.HTTP_201_CREATED)

        second = self.client.post(
            url, {'request_type': ApprovalRequest.RequestType.PHASE_1_SIGNOFF, 'project': self.project.id},
            format='json',
        )
        self.assertEqual(second.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn(
            'A pending approval request of this type already exists for this project.',
            str(second.data),
        )

    def test_different_request_type_for_same_project_is_allowed(self):
        url = reverse('approvalrequest-list')
        first = self.client.post(
            url, {'request_type': ApprovalRequest.RequestType.PHASE_1_SIGNOFF, 'project': self.project.id},
            format='json',
        )
        self.assertEqual(first.status_code, status.HTTP_201_CREATED)

        second = self.client.post(
            url, {'request_type': ApprovalRequest.RequestType.PHASE_2_SIGNOFF, 'project': self.project.id},
            format='json',
        )
        self.assertEqual(second.status_code, status.HTTP_201_CREATED)


class ProjectPendingApprovalRequestsTests(ProjectRequirementsTestMixin, APITestCase):
    def test_pending_approval_requests_reflects_outstanding_signoffs(self):
        url = reverse('project-detail', args=[self.project.id])
        response = self.client.get(url)
        self.assertEqual(response.data['pending_approval_requests'], [])

        approval = ApprovalRequest.objects.create(
            request_type=ApprovalRequest.RequestType.PHASE_1_SIGNOFF,
            project=self.project,
            requested_by=self.rep,
        )

        response = self.client.get(url)
        self.assertEqual(response.data['pending_approval_requests'], [ApprovalRequest.RequestType.PHASE_1_SIGNOFF])

        approval.status = ApprovalRequest.Status.APPROVED
        approval.decided_by = self.manager
        approval.save()

        response = self.client.get(url)
        self.assertEqual(response.data['pending_approval_requests'], [])


class InteractionOutcomeTests(APITestCase):
    def setUp(self):
        self.rep = User.objects.create_user(username='rep', password='pass', role=User.Role.SALES_REP)
        self.company = Company.objects.create(name='Acme', owner=self.rep)
        self.lead = Lead.objects.create(company=self.company, assigned_to=self.rep, status=Lead.Status.COLD)
        self.client.force_authenticate(self.rep)

    def test_non_responded_outcome_does_not_flip_lead_to_hot(self):
        original_last_activity = self.lead.last_activity_at
        url = reverse('interaction-list')
        response = self.client.post(url, {
            'lead': self.lead.id,
            'type': Interaction.Type.CALL,
            'outcome': Interaction.Outcome.NO_ANSWER,
        }, format='json')
        self.assertEqual(response.status_code, status.HTTP_201_CREATED)

        self.lead.refresh_from_db()
        self.assertEqual(self.lead.status, Lead.Status.COLD)
        self.assertEqual(self.lead.last_activity_at, original_last_activity)

    def test_responded_outcome_flips_lead_to_hot(self):
        url = reverse('interaction-list')
        response = self.client.post(url, {
            'lead': self.lead.id,
            'type': Interaction.Type.CALL,
            'outcome': Interaction.Outcome.RESPONDED,
        }, format='json')
        self.assertEqual(response.status_code, status.HTTP_201_CREATED)

        self.lead.refresh_from_db()
        self.assertEqual(self.lead.status, Lead.Status.HOT)


@override_settings(MEDIA_ROOT=tempfile.mkdtemp())
class PhaseRequirementUploadTests(ProjectRequirementsTestMixin, APITestCase):
    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(settings.MEDIA_ROOT, ignore_errors=True)
        super().tearDownClass()

    def test_uploading_document_marks_requirement_complete(self):
        requirement = self.project.requirements.get(phase=1, label='Signed MSA')
        url = reverse('phaserequirement-detail', args=[requirement.id])
        upload = SimpleUploadedFile('msa.pdf', b'file contents', content_type='application/pdf')

        response = self.client.patch(url, {'document': upload}, format='multipart')
        self.assertEqual(response.status_code, status.HTTP_200_OK)

        requirement.refresh_from_db()
        self.assertTrue(requirement.is_complete)
        self.assertEqual(requirement.completed_by, self.manager)
        self.assertIsNotNone(requirement.completed_at)
        self.assertTrue(requirement.document.name)
