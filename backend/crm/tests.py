from datetime import timedelta
from decimal import Decimal

from django.db import IntegrityError, transaction
from django.test import TestCase
from django.utils import timezone
from rest_framework import status
from rest_framework.reverse import reverse
from rest_framework.test import APIClient, APITestCase

from .models import (
    ActivityEvent, ApprovalRequest, Company, Contact, Deal, Interaction, Lead, PhaseRequirement, Project, User,
)


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
        self.contact = Contact.objects.create(company=self.company, name='Jane Doe')
        self.lead = Lead.objects.create(company=self.company, contact=self.contact, assigned_to=self.rep)
        self.project = self.lead.project

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


class ProjectRequirementsTestMixin:
    def setUp(self):
        self.manager = User.objects.create_user(username='mgr', password='pass', role=User.Role.SALES_MANAGER)
        self.rep = User.objects.create_user(username='rep', password='pass', role=User.Role.SALES_REP)
        self.company = Company.objects.create(name='Acme', owner=self.rep)
        self.contact = Contact.objects.create(company=self.company, name='Jane Doe')
        # A Deal already exists on the company, but Project.deal starts out
        # unlinked -- it's only connected once Phase 1 completes.
        self.deal = Deal.objects.create(
            company=self.company, contact=self.contact, value=Decimal('1000.00'), assigned_to=self.rep,
        )
        self.lead = Lead.objects.create(company=self.company, contact=self.contact, assigned_to=self.rep)
        self.project = self.lead.project
        self.client.force_authenticate(self.manager)


class ProjectPhaseTransitionTests(ProjectRequirementsTestMixin, APITestCase):
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

    def test_phase_1_starts_in_progress_on_lead_creation(self):
        self.assertEqual(self.project.phase_1_status, Project.PhaseStatus.IN_PROGRESS)
        self.assertEqual(self.project.phase_2_status, Project.PhaseStatus.NOT_STARTED)
        self.assertEqual(self.project.lead, self.lead)

    def test_phase_2_cannot_start_while_phase_1_incomplete(self):
        response = self._patch_project(phase_2_status=Project.PhaseStatus.IN_PROGRESS)
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.project.refresh_from_db()
        self.assertEqual(self.project.phase_2_status, Project.PhaseStatus.NOT_STARTED)

    def test_phase_cannot_complete_without_approved_signoff(self):
        response = self._patch_project(phase_1_status=Project.PhaseStatus.COMPLETE)
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.project.refresh_from_db()
        self.assertEqual(self.project.phase_1_status, Project.PhaseStatus.IN_PROGRESS)

    def test_maintenance_flips_true_once_all_phases_complete(self):
        self._approve_signoff(ApprovalRequest.RequestType.PHASE_1_SIGNOFF)
        response = self._patch_project(phase_1_status=Project.PhaseStatus.COMPLETE)
        self.assertEqual(response.status_code, status.HTTP_200_OK)

        # Phase 2 auto-advances to IN_PROGRESS as a side effect of Phase 1
        # completing, so no explicit PATCH is needed to start it.
        self.project.refresh_from_db()
        self.assertEqual(self.project.phase_2_status, Project.PhaseStatus.IN_PROGRESS)

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

    def _make_overdue(self, lead):
        requirement = lead.project.requirements.first()
        requirement.due_date = timezone.localdate() - timedelta(days=1)
        requirement.save(update_fields=['due_date'])
        return requirement

    def test_rep_sees_only_their_own_overdue_tasks(self):
        requirement1 = self._make_overdue(self.lead1)
        requirement2 = self._make_overdue(self.lead2)

        self.client.force_authenticate(self.rep1)
        response = self.client.get(reverse('dashboard'))
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        ids = {row['id'] for row in response.data['overdue_tasks']['results']}
        self.assertIn(requirement1.id, ids)
        self.assertNotIn(requirement2.id, ids)

    def test_manager_sees_all_overdue_tasks(self):
        requirement1 = self._make_overdue(self.lead1)
        requirement2 = self._make_overdue(self.lead2)

        self.client.force_authenticate(self.manager)
        response = self.client.get(reverse('dashboard'))
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        ids = {row['id'] for row in response.data['overdue_tasks']['results']}
        self.assertIn(requirement1.id, ids)
        self.assertIn(requirement2.id, ids)


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
        PhaseRequirement.objects.filter(pk__in=phase1_ids).update(status=PhaseRequirement.Status.COMPLETED)

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
        self.assertEqual(self.project.phase_1_status, Project.PhaseStatus.IN_PROGRESS)

    def test_can_move_to_awaiting_approval_once_all_requirements_complete(self):
        self.project.requirements.filter(phase=1).update(status=PhaseRequirement.Status.COMPLETED)
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


class PhaseRequirementConfirmationTests(ProjectRequirementsTestMixin, APITestCase):
    def _manager_task(self, **kwargs):
        return PhaseRequirement.objects.create(
            project=self.project,
            phase=1,
            label='Manager Gate',
            confirmation_authority=PhaseRequirement.ConfirmationAuthority.MANAGER,
            **kwargs,
        )

    def test_rep_authority_task_completes_immediately(self):
        requirement = self.project.requirements.filter(
            confirmation_authority=PhaseRequirement.ConfirmationAuthority.REP,
        ).first()
        self.client.force_authenticate(self.rep)
        url = reverse('phaserequirement-detail', args=[requirement.id])
        response = self.client.patch(url, {'status': PhaseRequirement.Status.COMPLETED}, format='json')
        self.assertEqual(response.status_code, status.HTTP_200_OK)

        requirement.refresh_from_db()
        self.assertEqual(requirement.status, PhaseRequirement.Status.COMPLETED)
        self.assertIsNone(requirement.confirmed_by)
        self.assertTrue(requirement.is_confirmed_complete)
        self.assertEqual(requirement.updated_by, self.rep)

    def test_manager_authority_task_awaits_confirmation_when_rep_completes_it(self):
        requirement = self._manager_task()
        self.client.force_authenticate(self.rep)
        url = reverse('phaserequirement-detail', args=[requirement.id])
        response = self.client.patch(url, {'status': PhaseRequirement.Status.COMPLETED}, format='json')
        self.assertEqual(response.status_code, status.HTTP_200_OK)

        requirement.refresh_from_db()
        self.assertEqual(requirement.status, PhaseRequirement.Status.COMPLETED)
        self.assertIsNone(requirement.confirmed_by)
        self.assertFalse(requirement.is_confirmed_complete)

    def test_manager_confirms_manager_authority_task(self):
        requirement = self._manager_task(status=PhaseRequirement.Status.COMPLETED)
        url = reverse('phaserequirement-detail', args=[requirement.id])
        # self.client is already authenticated as self.manager (mixin setUp).
        response = self.client.patch(url, {'status': PhaseRequirement.Status.COMPLETED}, format='json')
        self.assertEqual(response.status_code, status.HTTP_200_OK)

        requirement.refresh_from_db()
        self.assertEqual(requirement.confirmed_by, self.manager)
        self.assertIsNotNone(requirement.confirmed_at)
        self.assertTrue(requirement.is_confirmed_complete)

    def test_rep_cannot_confirm_manager_authority_task(self):
        requirement = self._manager_task()
        self.client.force_authenticate(self.rep)
        url = reverse('phaserequirement-detail', args=[requirement.id])
        response = self.client.patch(url, {'status': PhaseRequirement.Status.COMPLETED}, format='json')
        self.assertEqual(response.status_code, status.HTTP_200_OK)

        requirement.refresh_from_db()
        # The rep's action is accepted (status changes), but it does not
        # confirm the task -- confirmation requires a management role.
        self.assertEqual(requirement.status, PhaseRequirement.Status.COMPLETED)
        self.assertIsNone(requirement.confirmed_by)
        self.assertFalse(requirement.is_confirmed_complete)

    def test_rep_cannot_patch_confirmed_by_directly(self):
        requirement = self._manager_task()
        self.client.force_authenticate(self.rep)
        url = reverse('phaserequirement-detail', args=[requirement.id])
        response = self.client.patch(url, {'confirmed_by': self.rep.id}, format='json')
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        requirement.refresh_from_db()
        self.assertIsNone(requirement.confirmed_by)

    def test_rep_cannot_patch_confirmed_at_directly(self):
        requirement = self._manager_task()
        self.client.force_authenticate(self.rep)
        url = reverse('phaserequirement-detail', args=[requirement.id])
        response = self.client.patch(url, {'confirmed_at': timezone.now().isoformat()}, format='json')
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        requirement.refresh_from_db()
        self.assertIsNone(requirement.confirmed_at)

    def test_not_applicable_tasks_excluded_from_progress(self):
        phase1 = list(self.project.requirements.filter(phase=1))
        for requirement in phase1[:-1]:
            requirement.status = PhaseRequirement.Status.NOT_APPLICABLE
            requirement.save()
        phase1[-1].status = PhaseRequirement.Status.COMPLETED
        phase1[-1].save()

        url = reverse('project-detail', args=[self.project.id])
        response = self.client.get(url)
        self.assertEqual(response.data['phase_progress'][1], {'completed': 1, 'total': 1, 'percent': 100})


class ProjectPhase1DealAdvanceTests(ProjectRequirementsTestMixin, APITestCase):
    def _complete_phase_1(self):
        self.project.requirements.filter(phase=1).update(status=PhaseRequirement.Status.COMPLETED)
        approval = ApprovalRequest.objects.create(
            request_type=ApprovalRequest.RequestType.PHASE_1_SIGNOFF,
            project=self.project,
            requested_by=self.rep,
        )
        approve_url = reverse('approvalrequest-detail', args=[approval.id])
        approve_response = self.client.patch(approve_url, {'status': ApprovalRequest.Status.APPROVED}, format='json')
        self.assertEqual(approve_response.status_code, status.HTTP_200_OK)

        project_url = reverse('project-detail', args=[self.project.id])
        response = self.client.patch(project_url, {'phase_1_status': Project.PhaseStatus.COMPLETE}, format='json')
        self.assertEqual(response.status_code, status.HTTP_200_OK)

    def test_phase_1_complete_closes_existing_deal_and_advances_phase_2(self):
        self.assertIsNone(self.project.deal)

        self._complete_phase_1()

        self.project.refresh_from_db()
        self.assertEqual(self.project.deal, self.deal)
        self.deal.refresh_from_db()
        self.assertEqual(self.deal.stage, Deal.Stage.CLOSED_WON)
        self.assertEqual(self.project.phase_2_status, Project.PhaseStatus.IN_PROGRESS)

    def test_phase_1_complete_creates_deal_when_none_exists_on_company(self):
        self.deal.delete()
        self.assertFalse(Deal.objects.filter(company=self.company).exists())

        self._complete_phase_1()

        self.project.refresh_from_db()
        deal = Deal.objects.get(company=self.company)
        self.assertEqual(self.project.deal, deal)
        self.assertEqual(deal.stage, Deal.Stage.CLOSED_WON)
        self.assertIsNone(deal.value)
        self.assertEqual(deal.assigned_to, self.lead.assigned_to)
        self.assertEqual(self.project.phase_2_status, Project.PhaseStatus.IN_PROGRESS)


class ApprovalPhaseSignoffAutoCompletionTests(ProjectRequirementsTestMixin, APITestCase):
    def _create_signoff(self, request_type):
        return ApprovalRequest.objects.create(
            request_type=request_type, project=self.project, requested_by=self.rep,
        )

    def _decide(self, approval, decision):
        url = reverse('approvalrequest-detail', args=[approval.id])
        payload = {'status': decision}
        if decision == ApprovalRequest.Status.REJECTED:
            payload['decision_note'] = 'Needs rework'
        return self.client.patch(url, payload, format='json')

    def test_approving_phase_1_signoff_completes_phase_1_and_advances_deal_and_phase_2(self):
        self.assertIsNone(self.project.deal)
        approval = self._create_signoff(ApprovalRequest.RequestType.PHASE_1_SIGNOFF)

        response = self._decide(approval, ApprovalRequest.Status.APPROVED)
        self.assertEqual(response.status_code, status.HTTP_200_OK)

        self.project.refresh_from_db()
        self.assertEqual(self.project.phase_1_status, Project.PhaseStatus.COMPLETE)
        self.assertEqual(self.project.phase_2_status, Project.PhaseStatus.IN_PROGRESS)
        self.assertEqual(self.project.deal, self.deal)
        self.deal.refresh_from_db()
        self.assertEqual(self.deal.stage, Deal.Stage.CLOSED_WON)

    def test_approving_phase_2_signoff_completes_phase_2_and_advances_phase_3(self):
        self.project.phase_1_status = Project.PhaseStatus.COMPLETE
        self.project.phase_2_status = Project.PhaseStatus.IN_PROGRESS
        self.project.save()
        approval = self._create_signoff(ApprovalRequest.RequestType.PHASE_2_SIGNOFF)

        response = self._decide(approval, ApprovalRequest.Status.APPROVED)
        self.assertEqual(response.status_code, status.HTTP_200_OK)

        self.project.refresh_from_db()
        self.assertEqual(self.project.phase_2_status, Project.PhaseStatus.COMPLETE)
        self.assertEqual(self.project.phase_3_status, Project.PhaseStatus.IN_PROGRESS)

    def test_approving_phase_3_signoff_completes_phase_3_and_sets_maintenance(self):
        self.project.phase_1_status = Project.PhaseStatus.COMPLETE
        self.project.phase_2_status = Project.PhaseStatus.COMPLETE
        self.project.phase_3_status = Project.PhaseStatus.IN_PROGRESS
        self.project.save()
        approval = self._create_signoff(ApprovalRequest.RequestType.PHASE_3_SIGNOFF)

        response = self._decide(approval, ApprovalRequest.Status.APPROVED)
        self.assertEqual(response.status_code, status.HTTP_200_OK)

        self.project.refresh_from_db()
        self.assertEqual(self.project.phase_3_status, Project.PhaseStatus.COMPLETE)
        self.assertTrue(self.project.maintenance)

    def test_rejecting_phase_signoff_returns_awaiting_approval_phase_to_in_progress(self):
        self.project.phase_1_status = Project.PhaseStatus.AWAITING_APPROVAL
        self.project.save()
        approval = self._create_signoff(ApprovalRequest.RequestType.PHASE_1_SIGNOFF)

        response = self._decide(approval, ApprovalRequest.Status.REJECTED)
        self.assertEqual(response.status_code, status.HTTP_200_OK)

        self.project.refresh_from_db()
        self.assertEqual(self.project.phase_1_status, Project.PhaseStatus.IN_PROGRESS)

    def test_rejecting_phase_signoff_leaves_in_progress_phase_unchanged(self):
        # phase_1_status is already IN_PROGRESS from Lead creation -- rejection
        # should not error or touch it when it was never AWAITING_APPROVAL.
        approval = self._create_signoff(ApprovalRequest.RequestType.PHASE_1_SIGNOFF)

        response = self._decide(approval, ApprovalRequest.Status.REJECTED)
        self.assertEqual(response.status_code, status.HTTP_200_OK)

        self.project.refresh_from_db()
        self.assertEqual(self.project.phase_1_status, Project.PhaseStatus.IN_PROGRESS)


class ArchiveTestMixin:
    def setUp(self):
        self.manager = User.objects.create_user(username='mgr', password='pass', role=User.Role.SALES_MANAGER)
        self.admin = User.objects.create_user(username='admin1', password='pass', role=User.Role.SYSTEM_ADMIN)
        self.rep = User.objects.create_user(username='rep', password='pass', role=User.Role.SALES_REP)
        self.other_rep = User.objects.create_user(username='rep2', password='pass', role=User.Role.SALES_REP)
        self.company = Company.objects.create(name='Acme', owner=self.rep)
        self.contact = Contact.objects.create(company=self.company, name='Jane Doe')
        self.lead = Lead.objects.create(company=self.company, contact=self.contact, assigned_to=self.rep)
        self.project = self.lead.project


class CompanyRolePermissionTests(ArchiveTestMixin, APITestCase):
    def test_manager_can_create_company(self):
        self.client.force_authenticate(self.manager)
        response = self.client.post(reverse('company-list'), {'name': 'New Co'}, format='json')
        self.assertEqual(response.status_code, status.HTTP_201_CREATED)

    def test_manager_can_update_company(self):
        self.client.force_authenticate(self.manager)
        url = reverse('company-detail', args=[self.company.id])
        response = self.client.patch(url, {'industry': 'Retail'}, format='json')
        self.assertEqual(response.status_code, status.HTTP_200_OK)

    def test_system_admin_cannot_create_company(self):
        self.client.force_authenticate(self.admin)
        response = self.client.post(reverse('company-list'), {'name': 'New Co'}, format='json')
        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)

    def test_system_admin_cannot_update_company(self):
        self.client.force_authenticate(self.admin)
        url = reverse('company-detail', args=[self.company.id])
        response = self.client.patch(url, {'industry': 'Retail'}, format='json')
        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)

    def test_system_admin_can_read_company(self):
        self.client.force_authenticate(self.admin)
        url = reverse('company-detail', args=[self.company.id])
        response = self.client.get(url)
        self.assertEqual(response.status_code, status.HTTP_200_OK)


class CompanyMineFilterAndAssignedEditTests(ArchiveTestMixin, APITestCase):
    def test_mine_filter_includes_owned_companies(self):
        other_company = Company.objects.create(name='Other Co', owner=self.other_rep)
        self.client.force_authenticate(self.rep)
        response = self.client.get(reverse('company-list'), {'mine': 'true'})
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        ids = {row['id'] for row in response.data}
        self.assertIn(self.company.id, ids)
        self.assertNotIn(other_company.id, ids)

    def test_mine_filter_includes_companies_with_an_assigned_lead_but_no_ownership(self):
        other_company = Company.objects.create(name='Other Co', owner=self.manager)
        Lead.objects.create(company=other_company, assigned_to=self.rep)

        self.client.force_authenticate(self.rep)
        response = self.client.get(reverse('company-list'), {'mine': 'true'})
        ids = {row['id'] for row in response.data}
        self.assertIn(self.company.id, ids)
        self.assertIn(other_company.id, ids)

    def test_without_mine_filter_rep_sees_every_company(self):
        other_company = Company.objects.create(name='Other Co', owner=self.other_rep)
        self.client.force_authenticate(self.rep)
        response = self.client.get(reverse('company-list'))
        ids = {row['id'] for row in response.data}
        self.assertIn(self.company.id, ids)
        self.assertIn(other_company.id, ids)

    def test_rep_can_edit_company_they_own(self):
        self.client.force_authenticate(self.rep)
        url = reverse('company-detail', args=[self.company.id])
        response = self.client.patch(url, {'industry': 'Retail'}, format='json')
        self.assertEqual(response.status_code, status.HTTP_200_OK)

    def test_rep_cannot_edit_unrelated_company(self):
        other_company = Company.objects.create(name='Other Co', owner=self.manager)
        self.client.force_authenticate(self.rep)
        url = reverse('company-detail', args=[other_company.id])
        response = self.client.patch(url, {'industry': 'Retail'}, format='json')
        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)

    def test_rep_can_edit_company_with_assigned_lead_but_no_ownership(self):
        other_company = Company.objects.create(name='Other Co', owner=self.manager)
        Lead.objects.create(company=other_company, assigned_to=self.rep)

        self.client.force_authenticate(self.rep)
        url = reverse('company-detail', args=[other_company.id])
        response = self.client.patch(url, {'industry': 'Retail'}, format='json')
        self.assertEqual(response.status_code, status.HTTP_200_OK)


class CompanyArchiveActionTests(ArchiveTestMixin, APITestCase):
    def test_manager_can_archive_company_and_it_cascades(self):
        self.client.force_authenticate(self.manager)
        url = reverse('company-archive', args=[self.company.id])
        response = self.client.post(url, {'archive_reason': 'Client churned'}, format='json')
        self.assertEqual(response.status_code, status.HTTP_200_OK)

        self.company.refresh_from_db()
        self.lead.refresh_from_db()
        self.project.refresh_from_db()
        self.assertTrue(self.company.is_archived)
        self.assertEqual(self.company.archived_by, self.manager)
        self.assertIsNotNone(self.company.archived_at)
        self.assertEqual(self.company.archive_reason, 'Client churned')
        self.assertTrue(self.lead.is_archived)
        self.assertTrue(self.project.is_archived)

    def test_archive_without_reason_is_rejected(self):
        self.client.force_authenticate(self.manager)
        url = reverse('company-archive', args=[self.company.id])
        response = self.client.post(url, {}, format='json')
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.company.refresh_from_db()
        self.assertFalse(self.company.is_archived)

    def test_manager_can_unarchive_company(self):
        self.company.is_archived = True
        self.company.archived_by = self.manager
        self.company.archived_at = timezone.now()
        self.company.archive_reason = 'test'
        self.company.save()

        self.client.force_authenticate(self.manager)
        url = reverse('company-unarchive', args=[self.company.id])
        response = self.client.post(url, {}, format='json')
        self.assertEqual(response.status_code, status.HTTP_200_OK)

        self.company.refresh_from_db()
        self.assertFalse(self.company.is_archived)
        self.assertIsNone(self.company.archived_by)
        self.assertIsNone(self.company.archived_at)
        self.assertEqual(self.company.archive_reason, '')

    def test_rep_cannot_archive_company(self):
        self.client.force_authenticate(self.rep)
        url = reverse('company-archive', args=[self.company.id])
        response = self.client.post(url, {'archive_reason': 'Nope'}, format='json')
        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)

    def test_system_admin_cannot_archive_company(self):
        self.client.force_authenticate(self.admin)
        url = reverse('company-archive', args=[self.company.id])
        response = self.client.post(url, {'archive_reason': 'Nope'}, format='json')
        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)


class CompanyDeleteTests(ArchiveTestMixin, APITestCase):
    def test_system_admin_cannot_delete_unarchived_company(self):
        self.client.force_authenticate(self.admin)
        url = reverse('company-detail', args=[self.company.id])
        response = self.client.delete(url)
        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)
        self.assertTrue(Company.objects.filter(pk=self.company.pk).exists())

    def test_system_admin_can_delete_archived_company(self):
        self.company.is_archived = True
        self.company.save()
        self.client.force_authenticate(self.admin)
        url = reverse('company-detail', args=[self.company.id])
        response = self.client.delete(url)
        self.assertEqual(response.status_code, status.HTTP_204_NO_CONTENT)
        self.assertFalse(Company.objects.filter(pk=self.company.pk).exists())

    def test_manager_cannot_delete_even_archived_company(self):
        self.company.is_archived = True
        self.company.save()
        self.client.force_authenticate(self.manager)
        url = reverse('company-detail', args=[self.company.id])
        response = self.client.delete(url)
        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)
        self.assertTrue(Company.objects.filter(pk=self.company.pk).exists())


class LeadRolePermissionAndArchiveTests(ArchiveTestMixin, APITestCase):
    def test_rep_can_create_lead_assigned_to_self(self):
        self.client.force_authenticate(self.rep)
        response = self.client.post(
            reverse('lead-list'), {'company': self.company.id, 'name': 'Acme Corp — New deal'}, format='json',
        )
        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        self.assertEqual(response.data['assigned_to'], self.rep.id)

    def test_rep_can_update_own_lead(self):
        self.client.force_authenticate(self.rep)
        url = reverse('lead-detail', args=[self.lead.id])
        response = self.client.patch(url, {'status': Lead.Status.HOT}, format='json')
        self.assertEqual(response.status_code, status.HTTP_200_OK)

    def test_rep_cannot_archive_lead(self):
        self.client.force_authenticate(self.rep)
        url = reverse('lead-archive', args=[self.lead.id])
        response = self.client.post(url, {'archive_reason': 'Cold'}, format='json')
        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)

    def test_manager_can_archive_lead(self):
        self.client.force_authenticate(self.manager)
        url = reverse('lead-archive', args=[self.lead.id])
        response = self.client.post(url, {'archive_reason': 'Cold'}, format='json')
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.lead.refresh_from_db()
        self.assertTrue(self.lead.is_archived)
        self.assertEqual(self.lead.archived_by, self.manager)

    def test_system_admin_cannot_create_lead(self):
        self.client.force_authenticate(self.admin)
        response = self.client.post(reverse('lead-list'), {'company': self.company.id}, format='json')
        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)

    def test_system_admin_cannot_update_lead(self):
        self.client.force_authenticate(self.admin)
        url = reverse('lead-detail', args=[self.lead.id])
        response = self.client.patch(url, {'status': Lead.Status.HOT}, format='json')
        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)

    def test_system_admin_cannot_delete_unarchived_lead(self):
        self.client.force_authenticate(self.admin)
        url = reverse('lead-detail', args=[self.lead.id])
        response = self.client.delete(url)
        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)

    def test_system_admin_can_delete_archived_lead(self):
        self.lead.is_archived = True
        self.lead.save()
        self.client.force_authenticate(self.admin)
        url = reverse('lead-detail', args=[self.lead.id])
        response = self.client.delete(url)
        self.assertEqual(response.status_code, status.HTTP_204_NO_CONTENT)


class LeadNameTests(ArchiveTestMixin, APITestCase):
    def test_name_is_required_on_creation(self):
        self.client.force_authenticate(self.manager)
        response = self.client.post(
            reverse('lead-list'), {'company': self.company.id, 'assigned_to': self.rep.id}, format='json',
        )
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn('name', response.data)

    def test_creating_a_lead_with_a_name_succeeds(self):
        self.client.force_authenticate(self.manager)
        response = self.client.post(
            reverse('lead-list'),
            {'company': self.company.id, 'assigned_to': self.rep.id, 'name': 'Acme Corp — Renewal'},
            format='json',
        )
        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        self.assertEqual(response.data['name'], 'Acme Corp — Renewal')

    def test_search_matches_on_lead_name(self):
        other_company = Company.objects.create(name='Other Co', owner=self.manager)
        distinctive = Lead.objects.create(
            company=other_company, name='Distinctive Rollout Project', assigned_to=self.rep,
        )

        self.client.force_authenticate(self.manager)
        response = self.client.get(reverse('lead-list'), {'search': 'Distinctive Rollout'})
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        ids = {row['id'] for row in response.data}
        self.assertIn(distinctive.id, ids)
        self.assertNotIn(self.lead.id, ids)


class ProjectRolePermissionAndArchiveTests(ArchiveTestMixin, APITestCase):
    def test_system_admin_cannot_update_project(self):
        self.client.force_authenticate(self.admin)
        url = reverse('project-detail', args=[self.project.id])
        response = self.client.patch(url, {'current_phase': 2}, format='json')
        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)

    def test_manager_can_archive_project(self):
        self.client.force_authenticate(self.manager)
        url = reverse('project-archive', args=[self.project.id])
        response = self.client.post(url, {'archive_reason': 'Cancelled'}, format='json')
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.project.refresh_from_db()
        self.assertTrue(self.project.is_archived)

    def test_rep_cannot_archive_project(self):
        self.client.force_authenticate(self.rep)
        url = reverse('project-archive', args=[self.project.id])
        response = self.client.post(url, {'archive_reason': 'Cancelled'}, format='json')
        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)

    def test_system_admin_cannot_delete_unarchived_project(self):
        self.client.force_authenticate(self.admin)
        url = reverse('project-detail', args=[self.project.id])
        response = self.client.delete(url)
        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)

    def test_system_admin_can_delete_archived_project(self):
        self.project.is_archived = True
        self.project.save()
        self.client.force_authenticate(self.admin)
        url = reverse('project-detail', args=[self.project.id])
        response = self.client.delete(url)
        self.assertEqual(response.status_code, status.HTTP_204_NO_CONTENT)


class ArchivedRecordVisibilityTests(ArchiveTestMixin, APITestCase):
    def test_archived_company_excluded_by_default(self):
        self.company.is_archived = True
        self.company.save()
        self.client.force_authenticate(self.manager)
        response = self.client.get(reverse('company-list'))
        ids = {c['id'] for c in response.data}
        self.assertNotIn(self.company.id, ids)

    def test_archived_company_included_with_query_param(self):
        self.company.is_archived = True
        self.company.save()
        self.client.force_authenticate(self.manager)
        response = self.client.get(reverse('company-list'), {'include_archived': 'true'})
        ids = {c['id'] for c in response.data}
        self.assertIn(self.company.id, ids)

    def test_archived_lead_excluded_from_lead_list_by_default(self):
        self.lead.is_archived = True
        self.lead.save()
        self.client.force_authenticate(self.manager)
        response = self.client.get(reverse('lead-list'))
        ids = {lead['id'] for lead in response.data}
        self.assertNotIn(self.lead.id, ids)

        response = self.client.get(reverse('lead-list'), {'include_archived': 'true'})
        ids = {lead['id'] for lead in response.data}
        self.assertIn(self.lead.id, ids)


class ArchiveLeadApprovalFlowTests(ArchiveTestMixin, APITestCase):
    def test_manager_approving_archive_lead_request_archives_the_lead(self):
        self.client.force_authenticate(self.rep)
        create_response = self.client.post(reverse('approvalrequest-list'), {
            'request_type': ApprovalRequest.RequestType.ARCHIVE_LEAD,
            'lead': self.lead.id,
            'reason': 'Lead went cold',
        }, format='json')
        self.assertEqual(create_response.status_code, status.HTTP_201_CREATED)
        self.assertFalse(self.lead.is_archived)

        approval_id = create_response.data['id']
        self.client.force_authenticate(self.manager)
        approve_url = reverse('approvalrequest-detail', args=[approval_id])
        approve_response = self.client.patch(approve_url, {'status': ApprovalRequest.Status.APPROVED}, format='json')
        self.assertEqual(approve_response.status_code, status.HTTP_200_OK)

        self.lead.refresh_from_db()
        self.assertTrue(self.lead.is_archived)
        self.assertEqual(self.lead.archived_by, self.manager)
        self.assertIsNotNone(self.lead.archived_at)
        self.assertEqual(self.lead.archive_reason, 'Lead went cold')

    def test_rejecting_archive_lead_request_does_not_archive_the_lead(self):
        approval = ApprovalRequest.objects.create(
            request_type=ApprovalRequest.RequestType.ARCHIVE_LEAD,
            lead=self.lead,
            requested_by=self.rep,
            reason='Lead went cold',
        )
        self.client.force_authenticate(self.manager)
        url = reverse('approvalrequest-detail', args=[approval.id])
        response = self.client.patch(url, {'status': ApprovalRequest.Status.REJECTED}, format='json')
        self.assertEqual(response.status_code, status.HTTP_200_OK)

        self.lead.refresh_from_db()
        self.assertFalse(self.lead.is_archived)


class PhaseActivityEventTests(ProjectRequirementsTestMixin, APITestCase):
    def setUp(self):
        super().setUp()
        self.lead.status = Lead.Status.COLD
        self.lead.save()
        self.requirement = self.project.requirements.filter(
            phase=1, confirmation_authority=PhaseRequirement.ConfirmationAuthority.REP,
        ).first()

    def test_completing_a_task_creates_a_phase_activity_event(self):
        url = reverse('phaserequirement-detail', args=[self.requirement.id])
        response = self.client.patch(url, {'status': PhaseRequirement.Status.COMPLETED}, format='json')
        self.assertEqual(response.status_code, status.HTTP_200_OK)

        event = ActivityEvent.objects.get(lead=self.lead, category=ActivityEvent.Category.PHASE)
        self.assertIn(self.requirement.label, event.description)
        self.assertEqual(event.actor, self.manager)

    # Whether completing a task flips a COLD lead to HOT is now conditional
    # on client_facing (see ClientFacingTaskActivityTests below) -- this
    # class only covers the ActivityEvent/timeline side of task completion.

    def test_task_activity_event_appears_in_the_timeline(self):
        url = reverse('phaserequirement-detail', args=[self.requirement.id])
        self.client.patch(url, {'status': PhaseRequirement.Status.COMPLETED}, format='json')

        timeline_url = reverse('lead-timeline', args=[self.lead.id])
        response = self.client.get(timeline_url)
        self.assertEqual(response.status_code, status.HTTP_200_OK)

        phase_entries = [e for e in response.data if e['entry_type'] == 'ACTIVITY_EVENT']
        self.assertEqual(len(phase_entries), 1)
        self.assertEqual(phase_entries[0]['event_category'], 'PHASE')


class ClientFacingTaskActivityTests(ProjectRequirementsTestMixin, APITestCase):
    def setUp(self):
        super().setUp()
        self.lead.status = Lead.Status.COLD
        self.lead.save()
        self.original_last_activity_at = self.lead.last_activity_at

    def test_client_facing_task_completing_flips_cold_lead_to_hot(self):
        requirement = self.project.requirements.get(label='Client Proposal Confirmation')
        self.assertTrue(requirement.client_facing)

        url = reverse('phaserequirement-detail', args=[requirement.id])
        response = self.client.patch(url, {'status': PhaseRequirement.Status.COMPLETED}, format='json')
        self.assertEqual(response.status_code, status.HTTP_200_OK)

        self.lead.refresh_from_db()
        self.assertEqual(self.lead.status, Lead.Status.HOT)
        self.assertGreater(self.lead.last_activity_at, self.original_last_activity_at)
        # Mutually exclusive with the internal-activity field -- a
        # client-facing completion is treated exactly like a RESPONDED
        # interaction, which never touches last_internal_activity_at either.
        self.assertIsNone(self.lead.last_internal_activity_at)

    def test_internal_task_completing_does_not_flip_cold_lead_to_hot(self):
        requirement = self.project.requirements.get(label='Technical Specification')
        self.assertFalse(requirement.client_facing)

        url = reverse('phaserequirement-detail', args=[requirement.id])
        response = self.client.patch(url, {'status': PhaseRequirement.Status.COMPLETED}, format='json')
        self.assertEqual(response.status_code, status.HTTP_200_OK)

        self.lead.refresh_from_db()
        self.assertEqual(self.lead.status, Lead.Status.COLD)
        self.assertEqual(self.lead.last_activity_at, self.original_last_activity_at)
        self.assertIsNotNone(self.lead.last_internal_activity_at)


class PhaseDueDateTests(ProjectRequirementsTestMixin, APITestCase):
    def test_due_date_calculated_when_phase_starts(self):
        with_duration = self.project.requirements.filter(phase=2).first()
        with_duration.default_duration_days = 5
        with_duration.save(update_fields=['default_duration_days'])
        without_duration = self.project.requirements.filter(phase=2).exclude(pk=with_duration.pk).first()

        # Phase 2 hasn't started yet (phase 1 does, immediately, on Lead
        # creation -- see ProjectPhaseTransitionTests) -- so due dates aren't
        # calculated until start_phase(2) actually runs.
        self.assertIsNone(self.project.phase_2_started_at)
        self.assertIsNone(with_duration.due_date)

        self.project.start_phase(2)
        self.project.refresh_from_db()
        with_duration.refresh_from_db()
        without_duration.refresh_from_db()

        self.assertIsNotNone(self.project.phase_2_started_at)
        self.assertEqual(with_duration.due_date, timezone.localdate() + timedelta(days=5))
        # No duration configured on this one -- it has no deadline at all.
        self.assertIsNone(without_duration.due_date)

    def test_effective_due_date_is_the_earlier_of_due_and_committed(self):
        requirement = self.project.requirements.filter(phase=1).first()
        today = timezone.localdate()
        requirement.due_date = today + timedelta(days=10)
        requirement.committed_date = today + timedelta(days=3)
        requirement.save(update_fields=['due_date', 'committed_date'])
        self.assertEqual(requirement.effective_due_date, today + timedelta(days=3))

        requirement.committed_date = today + timedelta(days=20)
        requirement.save(update_fields=['committed_date'])
        self.assertEqual(requirement.effective_due_date, today + timedelta(days=10))

        requirement.due_date = None
        requirement.save(update_fields=['due_date'])
        self.assertEqual(requirement.effective_due_date, today + timedelta(days=20))

        requirement.committed_date = None
        requirement.save(update_fields=['committed_date'])
        self.assertIsNone(requirement.effective_due_date)

    def test_is_overdue_true_when_past_due_and_not_confirmed_complete(self):
        requirement = self.project.requirements.filter(phase=1).first()
        requirement.due_date = timezone.localdate() - timedelta(days=1)
        requirement.save(update_fields=['due_date'])
        self.assertTrue(requirement.is_overdue)

    def test_is_overdue_false_once_confirmed_complete(self):
        requirement = self.project.requirements.filter(
            phase=1, confirmation_authority=PhaseRequirement.ConfirmationAuthority.REP,
        ).first()
        requirement.due_date = timezone.localdate() - timedelta(days=1)
        requirement.status = PhaseRequirement.Status.COMPLETED
        requirement.save()
        self.assertTrue(requirement.is_confirmed_complete)
        self.assertFalse(requirement.is_overdue)

    def test_is_overdue_true_for_unconfirmed_manager_task_past_due(self):
        # Marked COMPLETED by a rep, but a MANAGER-authority task isn't
        # "confirmed complete" until a manager signs off -- so it can still
        # be overdue even though its status already reads COMPLETED.
        requirement = PhaseRequirement.objects.create(
            project=self.project,
            phase=1,
            label='Manager Gate',
            confirmation_authority=PhaseRequirement.ConfirmationAuthority.MANAGER,
            status=PhaseRequirement.Status.COMPLETED,
            due_date=timezone.localdate() - timedelta(days=1),
        )
        self.assertFalse(requirement.is_confirmed_complete)
        self.assertTrue(requirement.is_overdue)

    def test_is_overdue_false_when_not_applicable(self):
        requirement = self.project.requirements.filter(phase=1).first()
        requirement.due_date = timezone.localdate() - timedelta(days=1)
        requirement.status = PhaseRequirement.Status.NOT_APPLICABLE
        requirement.save()
        self.assertFalse(requirement.is_overdue)

    def test_changing_committed_date_logs_an_administrative_event(self):
        requirement = self.project.requirements.filter(phase=1).first()
        new_date = timezone.localdate() + timedelta(days=7)
        url = reverse('phaserequirement-detail', args=[requirement.id])
        response = self.client.patch(url, {'committed_date': new_date.isoformat()}, format='json')
        self.assertEqual(response.status_code, status.HTTP_200_OK)

        event = ActivityEvent.objects.get(lead=self.lead, category=ActivityEvent.Category.ADMINISTRATIVE)
        self.assertIn('none', event.description)
        self.assertIn(str(new_date), event.description)
        self.assertEqual(event.actor, self.manager)

        newer_date = new_date + timedelta(days=1)
        response = self.client.patch(url, {'committed_date': newer_date.isoformat()}, format='json')
        self.assertEqual(response.status_code, status.HTTP_200_OK)

        second_event = ActivityEvent.objects.filter(
            lead=self.lead, category=ActivityEvent.Category.ADMINISTRATIVE,
        ).exclude(pk=event.pk).get()
        self.assertIn(str(new_date), second_event.description)
        self.assertIn(str(newer_date), second_event.description)

    def test_committed_date_unchanged_does_not_log_an_event(self):
        requirement = self.project.requirements.filter(phase=1).first()
        url = reverse('phaserequirement-detail', args=[requirement.id])
        response = self.client.patch(url, {'notes': 'just a note'}, format='json')
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertFalse(
            ActivityEvent.objects.filter(lead=self.lead, category=ActivityEvent.Category.ADMINISTRATIVE).exists(),
        )


class ApprovalRequestDetailFieldsTests(APITestCase):
    def setUp(self):
        self.rep = User.objects.create_user(username='rep', password='pass', role=User.Role.SALES_REP)
        self.manager = User.objects.create_user(username='mgr', password='pass', role=User.Role.SALES_MANAGER)
        self.company = Company.objects.create(name='Acme', owner=self.rep)
        self.contact = Contact.objects.create(company=self.company, name='Jane Doe')
        self.lead = Lead.objects.create(
            company=self.company, contact=self.contact, name='Jane Doe', assigned_to=self.rep,
        )
        self.project = self.lead.project
        self.client.force_authenticate(self.manager)

    def test_archive_lead_request_detail_fields(self):
        approval = ApprovalRequest.objects.create(
            request_type=ApprovalRequest.RequestType.ARCHIVE_LEAD,
            lead=self.lead,
            requested_by=self.rep,
        )
        url = reverse('approvalrequest-detail', args=[approval.id])
        response = self.client.get(url)
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.data['lead_name'], 'Jane Doe')
        self.assertEqual(response.data['company_name'], 'Acme')
        self.assertEqual(response.data['requested_by_username'], 'rep')
        self.assertIsNone(response.data['phase_number'])

    def test_phase_signoff_request_detail_fields(self):
        approval = ApprovalRequest.objects.create(
            request_type=ApprovalRequest.RequestType.PHASE_2_SIGNOFF,
            project=self.project,
            requested_by=self.rep,
        )
        url = reverse('approvalrequest-detail', args=[approval.id])
        response = self.client.get(url)
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.data['lead_name'], 'Jane Doe')
        self.assertEqual(response.data['company_name'], 'Acme')
        self.assertEqual(response.data['phase_number'], 2)

    def test_lead_name_reflects_the_leads_own_name_even_without_a_contact(self):
        lead_no_contact = Lead.objects.create(
            company=self.company, name='Acme — Standalone deal', assigned_to=self.rep,
        )
        approval = ApprovalRequest.objects.create(
            request_type=ApprovalRequest.RequestType.ARCHIVE_LEAD,
            lead=lead_no_contact,
            requested_by=self.rep,
        )
        url = reverse('approvalrequest-detail', args=[approval.id])
        response = self.client.get(url)
        self.assertEqual(response.data['lead_name'], 'Acme — Standalone deal')


class ContactPermissionAndArchiveTests(APITestCase):
    def setUp(self):
        self.manager = User.objects.create_user(username='mgr', password='pass', role=User.Role.SALES_MANAGER)
        self.admin = User.objects.create_user(username='admin1', password='pass', role=User.Role.SYSTEM_ADMIN)
        self.rep = User.objects.create_user(username='rep', password='pass', role=User.Role.SALES_REP)
        self.other_rep = User.objects.create_user(username='rep2', password='pass', role=User.Role.SALES_REP)

        # Owned by other_rep, but self.rep has an assigned lead here -- this
        # is the scenario the "owns a lead" scoping is meant to allow.
        self.company = Company.objects.create(name='Acme', owner=self.other_rep)
        Lead.objects.create(company=self.company, assigned_to=self.rep)
        self.contact = Contact.objects.create(company=self.company, name='Jane Doe')

        # A second company where self.rep has no lead at all.
        self.other_company = Company.objects.create(name='Globex', owner=self.other_rep)
        self.other_contact = Contact.objects.create(company=self.other_company, name='John Roe')

    def test_manager_can_create_update_and_archive_any_contact(self):
        self.client.force_authenticate(self.manager)
        create = self.client.post(reverse('contact-list'), {
            'company': self.other_company.id, 'name': 'New Contact',
        }, format='json')
        self.assertEqual(create.status_code, status.HTTP_201_CREATED)

        url = reverse('contact-detail', args=[self.other_contact.id])
        update = self.client.patch(url, {'job_title': 'CFO'}, format='json')
        self.assertEqual(update.status_code, status.HTTP_200_OK)

        archive_url = reverse('contact-archive', args=[self.other_contact.id])
        archive = self.client.post(archive_url, {'archive_reason': 'Left the company'}, format='json')
        self.assertEqual(archive.status_code, status.HTTP_200_OK)
        self.other_contact.refresh_from_db()
        self.assertTrue(self.other_contact.is_archived)

    def test_rep_can_create_and_update_contact_on_company_where_they_own_a_lead(self):
        self.client.force_authenticate(self.rep)
        create = self.client.post(reverse('contact-list'), {
            'company': self.company.id, 'name': 'Another Contact',
        }, format='json')
        self.assertEqual(create.status_code, status.HTTP_201_CREATED)

        url = reverse('contact-detail', args=[self.contact.id])
        update = self.client.patch(url, {'job_title': 'CFO'}, format='json')
        self.assertEqual(update.status_code, status.HTTP_200_OK)

    def test_rep_cannot_create_or_update_contact_on_company_with_no_lead(self):
        self.client.force_authenticate(self.rep)
        create = self.client.post(reverse('contact-list'), {
            'company': self.other_company.id, 'name': 'Nope',
        }, format='json')
        self.assertEqual(create.status_code, status.HTTP_403_FORBIDDEN)

        url = reverse('contact-detail', args=[self.other_contact.id])
        update = self.client.patch(url, {'job_title': 'CFO'}, format='json')
        self.assertEqual(update.status_code, status.HTTP_403_FORBIDDEN)

    def test_rep_cannot_archive_contact(self):
        self.client.force_authenticate(self.rep)
        url = reverse('contact-archive', args=[self.contact.id])
        response = self.client.post(url, {'archive_reason': 'Nope'}, format='json')
        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)

    def test_any_role_can_read_any_contact(self):
        self.client.force_authenticate(self.rep)
        url = reverse('contact-detail', args=[self.other_contact.id])
        response = self.client.get(url)
        self.assertEqual(response.status_code, status.HTTP_200_OK)

    def test_system_admin_cannot_create_or_archive_but_can_read(self):
        self.client.force_authenticate(self.admin)
        create = self.client.post(reverse('contact-list'), {
            'company': self.company.id, 'name': 'Nope',
        }, format='json')
        self.assertEqual(create.status_code, status.HTTP_403_FORBIDDEN)

        archive_url = reverse('contact-archive', args=[self.contact.id])
        archive = self.client.post(archive_url, {'archive_reason': 'Nope'}, format='json')
        self.assertEqual(archive.status_code, status.HTTP_403_FORBIDDEN)

        read = self.client.get(reverse('contact-detail', args=[self.contact.id]))
        self.assertEqual(read.status_code, status.HTTP_200_OK)

    def test_system_admin_can_only_delete_archived_contact(self):
        self.client.force_authenticate(self.admin)
        url = reverse('contact-detail', args=[self.contact.id])
        response = self.client.delete(url)
        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)

        self.contact.is_archived = True
        self.contact.save()
        response = self.client.delete(url)
        self.assertEqual(response.status_code, status.HTTP_204_NO_CONTENT)


class NoteInteractionOutcomeTests(APITestCase):
    def setUp(self):
        self.rep = User.objects.create_user(username='rep', password='pass', role=User.Role.SALES_REP)
        self.company = Company.objects.create(name='Acme', owner=self.rep)
        self.lead = Lead.objects.create(company=self.company, assigned_to=self.rep, status=Lead.Status.COLD)
        self.client.force_authenticate(self.rep)

    def test_note_without_outcome_updates_last_activity_but_not_status(self):
        occurred_at = timezone.now() - timedelta(days=3)
        url = reverse('interaction-list')
        response = self.client.post(url, {
            'lead': self.lead.id,
            'type': Interaction.Type.NOTE,
            'notes': 'Left a voicemail summary.',
            'occurred_at': occurred_at.isoformat(),
        }, format='json')
        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        self.assertIsNone(response.data['outcome'])

        self.lead.refresh_from_db()
        self.assertEqual(self.lead.status, Lead.Status.COLD)
        self.assertEqual(self.lead.last_activity_at, occurred_at)

    def test_note_with_non_null_outcome_is_rejected(self):
        url = reverse('interaction-list')
        response = self.client.post(url, {
            'lead': self.lead.id,
            'type': Interaction.Type.NOTE,
            'outcome': Interaction.Outcome.RESPONDED,
        }, format='json')
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn('outcome', response.data)


class LeadTimelineTests(APITestCase):
    def setUp(self):
        self.rep = User.objects.create_user(username='rep', password='pass', role=User.Role.SALES_REP)
        self.other_rep = User.objects.create_user(username='rep2', password='pass', role=User.Role.SALES_REP)
        self.company = Company.objects.create(name='Acme', owner=self.rep)
        self.contact = Contact.objects.create(company=self.company, name='Jane Doe')
        self.lead = Lead.objects.create(company=self.company, contact=self.contact, assigned_to=self.rep)
        self.project = self.lead.project

    def test_timeline_merges_interactions_and_approvals_sorted_desc(self):
        now = timezone.now()
        older_interaction = Interaction.objects.create(
            lead=self.lead, type=Interaction.Type.CALL, outcome=Interaction.Outcome.RESPONDED,
            occurred_at=now - timedelta(days=5), created_by=self.rep,
        )
        approval = ApprovalRequest.objects.create(
            request_type=ApprovalRequest.RequestType.PHASE_1_SIGNOFF,
            project=self.project,
            requested_by=self.rep,
        )
        ApprovalRequest.objects.filter(pk=approval.pk).update(created_at=now - timedelta(days=2))
        newer_interaction = Interaction.objects.create(
            lead=self.lead, type=Interaction.Type.NOTE, occurred_at=now, created_by=self.rep,
        )

        self.client.force_authenticate(self.rep)
        url = reverse('lead-timeline', args=[self.lead.id])
        response = self.client.get(url)
        self.assertEqual(response.status_code, status.HTTP_200_OK)

        entries = response.data
        self.assertEqual(
            [(e['entry_type'], e['id']) for e in entries],
            [
                ('INTERACTION', newer_interaction.id),
                ('APPROVAL_REQUEST', approval.id),
                ('INTERACTION', older_interaction.id),
            ],
        )
        approval_entry = entries[1]
        self.assertEqual(approval_entry['status'], ApprovalRequest.Status.PENDING)
        self.assertEqual(approval_entry['reason'], '')
        self.assertEqual(approval_entry['decision_note'], '')

    def test_rep_cannot_view_another_reps_lead_timeline(self):
        self.client.force_authenticate(self.other_rep)
        url = reverse('lead-timeline', args=[self.lead.id])
        response = self.client.get(url)
        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)


class ApprovalRequestCrossManagementRoleTests(APITestCase):
    def setUp(self):
        self.sales_manager = User.objects.create_user(username='mgr', password='pass', role=User.Role.SALES_MANAGER)
        self.exec_manager = User.objects.create_user(
            username='exec', password='pass', role=User.Role.EXECUTIVE_MANAGER,
        )
        self.rep = User.objects.create_user(username='rep', password='pass', role=User.Role.SALES_REP)
        self.company = Company.objects.create(name='Acme', owner=self.rep)
        self.lead = Lead.objects.create(company=self.company, assigned_to=self.rep)

    def test_executive_manager_can_approve_sales_managers_request(self):
        approval = ApprovalRequest.objects.create(
            request_type=ApprovalRequest.RequestType.ARCHIVE_LEAD,
            lead=self.lead,
            requested_by=self.sales_manager,
        )
        self.client.force_authenticate(self.exec_manager)
        url = reverse('approvalrequest-detail', args=[approval.id])
        response = self.client.patch(url, {'status': ApprovalRequest.Status.APPROVED}, format='json')
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        approval.refresh_from_db()
        self.assertEqual(approval.status, ApprovalRequest.Status.APPROVED)
        self.assertEqual(approval.decided_by, self.exec_manager)

    def test_sales_manager_still_cannot_approve_own_request(self):
        approval = ApprovalRequest.objects.create(
            request_type=ApprovalRequest.RequestType.ARCHIVE_LEAD,
            lead=self.lead,
            requested_by=self.sales_manager,
        )
        self.client.force_authenticate(self.sales_manager)
        url = reverse('approvalrequest-detail', args=[approval.id])
        response = self.client.patch(url, {'status': ApprovalRequest.Status.APPROVED}, format='json')
        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)
