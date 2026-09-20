import importlib
from datetime import timedelta
from decimal import Decimal

from django.conf import settings
from django.core.files.uploadedfile import SimpleUploadedFile
from django.db import IntegrityError, transaction
from django.test import TestCase
from django.utils import timezone
from rest_framework import status
from rest_framework.reverse import reverse
from rest_framework.test import APIClient, APITestCase

from .models import (
    ActivityEvent, ApprovalRequest, Company, Contact, Deal, ExecutionStatusEvent, Interaction, Lead, Mention,
    PhaseRequirement, Project, RequirementTemplate, TaskAttachment, TaskFormField, TaskFormResponse, User,
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
        self.pm = User.objects.create_user(username='pm', password='pass', role=User.Role.PROJECT_MANAGER)
        self.company = Company.objects.create(name='Acme', owner=self.rep)
        self.contact = Contact.objects.create(company=self.company, name='Jane Doe')
        # A Deal already exists on the company, but Project.deal starts out
        # unlinked -- it's only connected once Phase 1 completes.
        self.deal = Deal.objects.create(
            company=self.company, contact=self.contact, value=Decimal('1000.00'), assigned_to=self.rep,
        )
        self.lead = Lead.objects.create(company=self.company, contact=self.contact, assigned_to=self.rep)
        self.project = self.lead.project
        # Phase 2 is PM-owned and can't start unassigned (see
        # ApprovalRequestSerializer.validate) -- every test built on this
        # mixin gets a valid PM by default so approving PHASE_1_SIGNOFF
        # works out of the box; tests exercising the rejection path clear it.
        self.project.project_manager = self.pm
        self.project.save(update_fields=['project_manager'])
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

        # Phase 3 follows the same approval-driven path as 1/2 -- setting
        # execution status to Completed raises the sign-off automatically
        # (moving the phase to AWAITING_APPROVAL, not straight to COMPLETE)
        # once its requirements are confirmed complete. Done as the assigned
        # PM, not self.manager, so the manager can still decide it afterwards
        # -- a request can't be decided by whoever raised it.
        self.project.requirements.filter(phase=3).update(
            status=PhaseRequirement.Status.COMPLETED, confirmed_by=self.manager, confirmed_at=timezone.now(),
        )
        self.client.force_authenticate(self.pm)
        exec_response = self._patch_project(phase_3_execution_status=Project.ExecutionStatus.COMPLETED)
        self.assertEqual(exec_response.status_code, status.HTTP_200_OK)
        self.client.force_authenticate(self.manager)
        self.project.refresh_from_db()
        self.assertEqual(self.project.phase_3_status, Project.PhaseStatus.AWAITING_APPROVAL)

        approval = ApprovalRequest.objects.get(
            project=self.project,
            request_type=ApprovalRequest.RequestType.PHASE_3_SIGNOFF,
            status=ApprovalRequest.Status.PENDING,
        )
        url = reverse('approvalrequest-detail', args=[approval.id])
        response = self.client.patch(url, {'status': ApprovalRequest.Status.APPROVED}, format='json')
        self.assertEqual(response.status_code, status.HTTP_200_OK)

        # Phase 4 auto-advances to IN_PROGRESS as a side effect of Phase 3
        # completing.
        self.project.refresh_from_db()
        self.assertEqual(self.project.phase_3_status, Project.PhaseStatus.COMPLETE)
        self.assertEqual(self.project.phase_4_status, Project.PhaseStatus.IN_PROGRESS)
        self.assertFalse(self.project.maintenance)

        # PHASE_4_SIGNOFF can only be decided by an EXECUTIVE_MANAGER.
        exec_manager = User.objects.create_user(
            username='exec_mm', password='pass', role=User.Role.EXECUTIVE_MANAGER,
        )
        approval = ApprovalRequest.objects.create(
            request_type=ApprovalRequest.RequestType.PHASE_4_SIGNOFF, project=self.project, requested_by=self.rep,
        )
        self.client.force_authenticate(exec_manager)
        approve_url = reverse('approvalrequest-detail', args=[approval.id])
        approve_response = self.client.patch(approve_url, {'status': ApprovalRequest.Status.APPROVED}, format='json')
        self.assertEqual(approve_response.status_code, status.HTTP_200_OK)
        self.client.force_authenticate(self.manager)

        response = self._patch_project(phase_4_status=Project.PhaseStatus.COMPLETE)
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


class CalendarApiTests(ProjectRequirementsTestMixin, APITestCase):
    """
    /api/calendar/ -- role-scoped like the dashboard's overdue-tasks list,
    except PROJECT_MANAGER gets a real scope here (their own managed
    projects), since the dashboard never implemented one for that role.
    """

    def setUp(self):
        super().setUp()
        self.today = timezone.localdate()
        self.this_year, self.this_month = self.today.year, self.today.month
        self.phase1_task = self.project.requirements.filter(phase=1).first()
        self.phase2_task = self.project.requirements.filter(phase=2).first()

        self.other_rep = User.objects.create_user(username='rep2', password='pass', role=User.Role.SALES_REP)
        self.other_pm = User.objects.create_user(username='pm2', password='pass', role=User.Role.PROJECT_MANAGER)
        self.other_company = Company.objects.create(name='Other Co', owner=self.other_rep)
        self.other_lead = Lead.objects.create(company=self.other_company, assigned_to=self.other_rep)
        self.other_lead.project.project_manager = self.other_pm
        self.other_lead.project.save(update_fields=['project_manager'])
        self.other_task = self.other_lead.project.requirements.filter(phase=1).first()

    def _set_due_date(self, task, due_date):
        task.due_date = due_date
        task.save(update_fields=['due_date'])

    def _calendar(self, year=None, month=None):
        params = {}
        if year is not None:
            params['year'] = year
        if month is not None:
            params['month'] = month
        return self.client.get(reverse('calendar'), params)

    def test_rep_sees_only_tasks_on_their_assigned_leads(self):
        self._set_due_date(self.phase1_task, self.today)
        self._set_due_date(self.other_task, self.today)

        self.client.force_authenticate(self.rep)
        response = self._calendar(self.this_year, self.this_month)
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        ids = {row['id'] for row in response.data}
        self.assertIn(self.phase1_task.id, ids)
        self.assertNotIn(self.other_task.id, ids)

    def test_pm_sees_only_tasks_on_projects_they_manage(self):
        self._set_due_date(self.phase2_task, self.today)
        self._set_due_date(self.other_task, self.today)

        self.client.force_authenticate(self.pm)
        response = self._calendar(self.this_year, self.this_month)
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        ids = {row['id'] for row in response.data}
        self.assertIn(self.phase2_task.id, ids)
        self.assertNotIn(self.other_task.id, ids)

    def test_manager_sees_everything(self):
        self._set_due_date(self.phase1_task, self.today)
        self._set_due_date(self.other_task, self.today)

        response = self._calendar(self.this_year, self.this_month)
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        ids = {row['id'] for row in response.data}
        self.assertIn(self.phase1_task.id, ids)
        self.assertIn(self.other_task.id, ids)

    def test_system_admin_sees_everything(self):
        admin = User.objects.create_user(username='admin1', password='pass', role=User.Role.SYSTEM_ADMIN)
        self._set_due_date(self.phase1_task, self.today)
        self._set_due_date(self.other_task, self.today)

        self.client.force_authenticate(admin)
        response = self._calendar(self.this_year, self.this_month)
        ids = {row['id'] for row in response.data}
        self.assertIn(self.phase1_task.id, ids)
        self.assertIn(self.other_task.id, ids)

    def test_tasks_outside_the_requested_month_are_excluded(self):
        # +32 days from the 1st guarantees a different month than today's,
        # though not necessarily "next" month if today's month has 31 days --
        # doesn't matter, both assertions key off this same date either way.
        other_month = self.today.replace(day=1) + timedelta(days=32)
        self._set_due_date(self.phase1_task, other_month)

        response = self._calendar(self.this_year, self.this_month)
        ids = {row['id'] for row in response.data}
        self.assertNotIn(self.phase1_task.id, ids)

        response = self._calendar(other_month.year, other_month.month)
        ids = {row['id'] for row in response.data}
        self.assertIn(self.phase1_task.id, ids)

    def test_not_applicable_tasks_are_excluded(self):
        self._set_due_date(self.phase1_task, self.today)
        self.phase1_task.status = PhaseRequirement.Status.NOT_APPLICABLE
        self.phase1_task.save(update_fields=['status'])

        response = self._calendar(self.this_year, self.this_month)
        ids = {row['id'] for row in response.data}
        self.assertNotIn(self.phase1_task.id, ids)

    def test_calendar_status_overdue(self):
        due = self.today - timedelta(days=1)
        self._set_due_date(self.phase1_task, due)
        response = self._calendar(due.year, due.month)
        row = next(r for r in response.data if r['id'] == self.phase1_task.id)
        self.assertEqual(row['calendar_status'], 'OVERDUE')

    def test_calendar_status_due_soon(self):
        due = self.today + timedelta(days=2)
        self._set_due_date(self.phase1_task, due)
        response = self._calendar(due.year, due.month)
        row = next(r for r in response.data if r['id'] == self.phase1_task.id)
        self.assertEqual(row['calendar_status'], 'DUE_SOON')

    def test_calendar_status_upcoming(self):
        self._set_due_date(self.phase1_task, self.today + timedelta(days=10))
        due = self.today + timedelta(days=10)
        response = self._calendar(due.year, due.month)
        row = next(r for r in response.data if r['id'] == self.phase1_task.id)
        self.assertEqual(row['calendar_status'], 'UPCOMING')

    def test_calendar_status_complete(self):
        due = self.today - timedelta(days=1)
        self._set_due_date(self.phase1_task, due)
        self.phase1_task.status = PhaseRequirement.Status.COMPLETED
        self.phase1_task.save(update_fields=['status'])

        response = self._calendar(due.year, due.month)
        row = next(r for r in response.data if r['id'] == self.phase1_task.id)
        # phase1_task's confirmation_authority is REP -- no separate
        # confirmation step needed for is_confirmed_complete to be True.
        self.assertEqual(row['calendar_status'], 'COMPLETE')

    def test_response_includes_lead_and_phase_info(self):
        self._set_due_date(self.phase1_task, self.today)
        response = self._calendar(self.this_year, self.this_month)
        row = next(r for r in response.data if r['id'] == self.phase1_task.id)
        self.assertEqual(row['lead_id'], self.lead.id)
        self.assertEqual(row['lead_name'], self.lead.name)
        self.assertEqual(row['phase'], 1)
        self.assertEqual(row['label'], self.phase1_task.label)
        self.assertEqual(row['due_date'], self.today.isoformat())

    def test_defaults_to_current_month_when_no_params_given(self):
        self._set_due_date(self.phase1_task, self.today)
        response = self._calendar()
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        ids = {row['id'] for row in response.data}
        self.assertIn(self.phase1_task.id, ids)

    def test_invalid_month_returns_400(self):
        response = self._calendar(self.this_year, 13)
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)

    def test_non_integer_query_params_return_400(self):
        response = self._calendar('not-a-year', 'not-a-month')
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)

    def test_unauthenticated_request_is_rejected(self):
        self.client.force_authenticate(None)
        response = self._calendar(self.this_year, self.this_month)
        self.assertEqual(response.status_code, status.HTTP_401_UNAUTHORIZED)


class ProjectProgressTests(ProjectRequirementsTestMixin, APITestCase):
    def test_default_requirements_are_generated_on_creation(self):
        self.assertEqual(self.project.requirements.filter(phase=1).count(), 3)
        self.assertEqual(self.project.requirements.filter(phase=2).count(), 5)
        self.assertEqual(self.project.requirements.filter(phase=3).count(), 3)
        self.assertEqual(self.project.requirements.filter(phase=4).count(), 3)

    def test_phase_progress_and_overall_progress(self):
        url = reverse('project-detail', args=[self.project.id])
        response = self.client.get(url)
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.data['phase_progress'][1], {'completed': 0, 'total': 3, 'percent': 0})
        self.assertEqual(response.data['phase_progress'][2], {'completed': 0, 'total': 5, 'percent': 0})
        self.assertEqual(response.data['phase_progress'][3], {'completed': 0, 'total': 3, 'percent': 0})
        self.assertEqual(response.data['phase_progress'][4], {'completed': 0, 'total': 3, 'percent': 0})
        self.assertEqual(response.data['overall_progress'], 0)

        phase1_ids = list(self.project.requirements.filter(phase=1).values_list('id', flat=True))[:2]
        PhaseRequirement.objects.filter(pk__in=phase1_ids).update(status=PhaseRequirement.Status.COMPLETED)

        response = self.client.get(url)
        self.assertEqual(response.data['phase_progress'][1], {'completed': 2, 'total': 3, 'percent': 67})
        # 2 of the project's 14 total requirements are complete.
        self.assertEqual(response.data['overall_progress'], 14)


class BoardOrderingTests(ProjectRequirementsTestMixin, APITestCase):
    """
    The board reorders cards *within* a column by writing board_order, and
    can never move one between columns -- a column is the phase, and only an
    approved sign-off changes that (see ProjectPhaseTransitionTests). These
    cover the half the board actually writes.
    """

    def _detail_url(self):
        return reverse('project-detail', args=[self.project.id])

    def test_board_order_defaults_to_zero_and_is_patchable(self):
        response = self.client.get(self._detail_url())
        self.assertEqual(response.data['board_order'], 0)

        response = self.client.patch(self._detail_url(), {'board_order': 3}, format='json')
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.project.refresh_from_db()
        self.assertEqual(self.project.board_order, 3)

    def test_board_order_patch_does_not_touch_the_phase(self):
        before = self.project.phase_1_status
        response = self.client.patch(self._detail_url(), {'board_order': 5}, format='json')
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.project.refresh_from_db()
        self.assertEqual(self.project.phase_1_status, before)
        self.assertEqual(self.project.current_phase, 1)

    def test_projects_can_be_ordered_by_board_order(self):
        second_lead = Lead.objects.create(company=self.company, contact=self.contact, assigned_to=self.rep)
        second = second_lead.project
        second.board_order = 0
        second.save(update_fields=['board_order'])
        self.project.board_order = 1
        self.project.save(update_fields=['board_order'])

        response = self.client.get(reverse('project-list'), {'ordering': 'board_order,-created_at'})
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual([row['id'] for row in response.data][:2], [second.id, self.project.id])

    def _reorder(self, ids):
        return self.client.post(reverse('project-reorder'), {'order': ids}, format='json')

    def test_reorder_writes_positions_for_a_whole_column_in_one_request(self):
        second = Lead.objects.create(company=self.company, contact=self.contact, assigned_to=self.rep).project

        response = self._reorder([second.id, self.project.id])
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.data['updated'], 2)

        second.refresh_from_db()
        self.project.refresh_from_db()
        self.assertEqual(second.board_order, 0)
        self.assertEqual(self.project.board_order, 1)

    def test_reorder_refuses_an_order_spanning_two_phases(self):
        other = Lead.objects.create(company=self.company, contact=self.contact, assigned_to=self.rep).project
        other.current_phase = 2
        other.save(update_fields=['current_phase'])

        response = self._reorder([other.id, self.project.id])
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn('phases advance through approval', str(response.data['order']))

        # Nothing was written -- a refused reorder is not a partial one.
        other.refresh_from_db()
        self.project.refresh_from_db()
        self.assertEqual(other.board_order, 0)
        self.assertEqual(self.project.board_order, 0)

    def test_reorder_never_moves_a_card_between_phases(self):
        before = self.project.current_phase
        self._reorder([self.project.id])
        self.project.refresh_from_db()
        self.assertEqual(self.project.current_phase, before)
        self.assertEqual(self.project.phase_1_status, Project.PhaseStatus.IN_PROGRESS)

    def test_reorder_is_scoped_to_what_the_requester_can_see(self):
        stranger = User.objects.create_user(username='rep-elsewhere', password='pass', role=User.Role.SALES_REP)
        other_company = Company.objects.create(name='Elsewhere', owner=stranger)
        hidden = Lead.objects.create(company=other_company, assigned_to=stranger).project

        self.client.force_authenticate(self.rep)
        response = self._reorder([hidden.id])
        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)
        hidden.refresh_from_db()
        self.assertEqual(hidden.board_order, 0)

    def test_reorder_rejects_a_malformed_order(self):
        response = self.client.post(reverse('project-reorder'), {'order': 'nope'}, format='json')
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)

    def test_card_payload_carries_the_lead_identity_the_board_draws(self):
        response = self.client.get(self._detail_url())
        self.assertEqual(response.data['lead_name'], self.lead.name)
        self.assertEqual(response.data['lead_status'], self.lead.status)
        self.assertEqual(response.data['assigned_to_username'], self.rep.username)
        self.assertEqual(response.data['overdue_task_count'], 0)

    def test_overdue_task_count_reflects_an_overdue_requirement(self):
        requirement = self.project.requirements.filter(phase=1).first()
        requirement.due_date = timezone.localdate() - timedelta(days=2)
        requirement.save(update_fields=['due_date'])

        response = self.client.get(self._detail_url())
        self.assertEqual(response.data['overdue_task_count'], 1)


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

    def test_responded_outcome_updates_last_activity_but_not_status(self):
        original_last_activity = self.lead.last_activity_at
        url = reverse('interaction-list')
        response = self.client.post(url, {
            'lead': self.lead.id,
            'type': Interaction.Type.CALL,
            'outcome': Interaction.Outcome.RESPONDED,
        }, format='json')
        self.assertEqual(response.status_code, status.HTTP_201_CREATED)

        self.lead.refresh_from_db()
        self.assertEqual(self.lead.status, Lead.Status.COLD)
        self.assertGreater(self.lead.last_activity_at, original_last_activity)


class MentionParsingTests(TestCase):
    """
    Interaction.save() parses @username out of notes and creates a Mention
    per known, non-self match -- these tests exercise that model-level
    behaviour directly, independent of the API.
    """

    def setUp(self):
        self.rep = User.objects.create_user(username='rep1', password='pass', role=User.Role.SALES_REP)
        self.other = User.objects.create_user(username='rep2', password='pass', role=User.Role.SALES_REP)
        self.company = Company.objects.create(name='Acme', owner=self.rep)
        self.lead = Lead.objects.create(company=self.company, assigned_to=self.rep)

    def _note(self, text, author=None):
        return Interaction.objects.create(
            lead=self.lead, type=Interaction.Type.NOTE, notes=text, created_by=author or self.rep,
        )

    def test_mentioning_a_known_user_creates_a_mention(self):
        interaction = self._note('Looping in @rep2 on this one.')
        mention = Mention.objects.get(interaction=interaction)
        self.assertEqual(mention.user, self.other)
        self.assertEqual(mention.created_by, self.rep)
        self.assertIsNone(mention.read_at)

    def test_mention_matching_is_case_insensitive(self):
        interaction = self._note('cc @REP2 please review.')
        self.assertTrue(Mention.objects.filter(interaction=interaction, user=self.other).exists())

    def test_multiple_mentions_each_create_a_mention(self):
        third = User.objects.create_user(username='mgr1', password='pass', role=User.Role.SALES_MANAGER)
        interaction = self._note('@rep2 and @mgr1 please take a look.')
        mentioned = set(Mention.objects.filter(interaction=interaction).values_list('user_id', flat=True))
        self.assertEqual(mentioned, {self.other.id, third.id})

    def test_self_mention_is_ignored(self):
        interaction = self._note('Reminder to myself: @rep1 follow up Monday.')
        self.assertFalse(Mention.objects.filter(interaction=interaction).exists())

    def test_unknown_username_is_ignored(self):
        interaction = self._note('cc @nobody_by_this_name')
        self.assertFalse(Mention.objects.filter(interaction=interaction).exists())
        # Doesn't raise, and the known mention alongside it still works.
        interaction2 = self._note('cc @nobody_by_this_name and @rep2')
        self.assertEqual(
            list(Mention.objects.filter(interaction=interaction2).values_list('user_id', flat=True)),
            [self.other.id],
        )

    def test_email_address_in_notes_is_not_mistaken_for_a_mention(self):
        # "@rep2" here is the tail of an email address, not a real mention --
        # the pattern requires the '@' to start the text or follow whitespace.
        interaction = self._note('Reach them at jane@rep2.example.com for now.')
        self.assertFalse(Mention.objects.filter(interaction=interaction).exists())

    def test_notes_with_no_mentions_creates_none(self):
        interaction = self._note('Had a good call, no follow-up needed.')
        self.assertFalse(Mention.objects.filter(interaction=interaction).exists())

    def test_resaving_the_same_notes_does_not_duplicate_the_mention(self):
        interaction = self._note('cc @rep2')
        interaction.save()
        interaction.save()
        self.assertEqual(Mention.objects.filter(interaction=interaction, user=self.other).count(), 1)

    def test_editing_notes_to_add_a_mention_creates_it(self):
        interaction = self._note('No mentions yet.')
        self.assertFalse(Mention.objects.filter(interaction=interaction).exists())
        interaction.notes = 'Now looping in @rep2.'
        interaction.save()
        self.assertTrue(Mention.objects.filter(interaction=interaction, user=self.other).exists())

    def test_mention_works_on_non_note_interaction_types(self):
        interaction = Interaction.objects.create(
            lead=self.lead, type=Interaction.Type.CALL, outcome=Interaction.Outcome.RESPONDED,
            notes='Discussed pricing, cc @rep2', created_by=self.rep,
        )
        self.assertTrue(Mention.objects.filter(interaction=interaction, user=self.other).exists())


class TaskMentionParsingTests(ProjectRequirementsTestMixin, APITestCase):
    """
    "#<id>" task references in Interaction notes -- Interaction.save() only
    turns one into a notification (a Mention with task set) when the author
    is a manager or PM, addressed to whoever COMPLETION_ROLE_BY_PHASE says is
    responsible for that task. Rendering the reference as a link is a
    separate, unconditional concern -- see InteractionApiTests below.
    """

    def setUp(self):
        super().setUp()
        self.phase1_task = self.project.requirements.filter(phase=1).first()
        self.phase2_task = self.project.requirements.filter(phase=2).first()
        self.phase3_task = self.project.requirements.filter(phase=3).first()
        self.phase4_task = self.project.requirements.filter(phase=4).first()

    def _note(self, text, author):
        return Interaction.objects.create(
            lead=self.lead, type=Interaction.Type.NOTE, notes=text, created_by=author,
        )

    def test_manager_tagging_a_phase1_task_notifies_the_assigned_rep(self):
        interaction = self._note(f'@{self.rep.username} please pick this up #{self.phase1_task.id}', self.manager)
        mention = Mention.objects.get(interaction=interaction, task=self.phase1_task)
        self.assertEqual(mention.user, self.rep)
        self.assertEqual(mention.created_by, self.manager)

    def test_manager_tagging_a_phase2_task_notifies_the_assigned_pm(self):
        interaction = self._note(f'Flagging #{self.phase2_task.id} for review.', self.manager)
        mention = Mention.objects.get(interaction=interaction, task=self.phase2_task)
        self.assertEqual(mention.user, self.pm)

    def test_manager_tagging_a_phase3_task_notifies_the_assigned_pm(self):
        interaction = self._note(f'#{self.phase3_task.id} needs attention.', self.manager)
        mention = Mention.objects.get(interaction=interaction, task=self.phase3_task)
        self.assertEqual(mention.user, self.pm)

    def test_manager_tagging_a_phase4_task_notifies_the_assigned_rep(self):
        interaction = self._note(f'#{self.phase4_task.id} -- client is asking.', self.manager)
        mention = Mention.objects.get(interaction=interaction, task=self.phase4_task)
        self.assertEqual(mention.user, self.rep)

    def test_pm_tagging_a_rep_task_notifies_the_rep(self):
        interaction = self._note(f'Could you check #{self.phase1_task.id}?', self.pm)
        mention = Mention.objects.get(interaction=interaction, task=self.phase1_task)
        self.assertEqual(mention.user, self.rep)

    def test_pm_tagging_their_own_task_does_not_self_notify(self):
        # self.pm is the assigned PM -- tagging a Phase 2 task means tagging
        # their own responsibility.
        interaction = self._note(f'Noting progress on #{self.phase2_task.id}.', self.pm)
        self.assertFalse(Mention.objects.filter(interaction=interaction, task=self.phase2_task).exists())

    def test_rep_tagging_a_task_does_not_notify_anyone(self):
        interaction = self._note(f'Working on #{self.phase1_task.id} now.', self.rep)
        self.assertFalse(Mention.objects.filter(interaction=interaction).exists())

    def test_system_admin_tagging_a_task_does_not_notify_anyone(self):
        admin = User.objects.create_user(username='admin1', password='pass', role=User.Role.SYSTEM_ADMIN)
        interaction = self._note(f'#{self.phase1_task.id} for the record.', admin)
        self.assertFalse(Mention.objects.filter(interaction=interaction).exists())

    def test_unknown_task_id_is_ignored(self):
        interaction = self._note('See #999999 for context.', self.manager)
        self.assertFalse(Mention.objects.filter(interaction=interaction).exists())

    def test_task_belonging_to_a_different_lead_is_ignored(self):
        other_lead = Lead.objects.create(company=self.company, contact=self.contact, assigned_to=self.rep)
        other_task = other_lead.project.requirements.filter(phase=1).first()
        interaction = self._note(f'Unrelated: #{other_task.id}', self.manager)
        self.assertFalse(Mention.objects.filter(interaction=interaction).exists())

    def test_no_notification_when_phase_2_task_has_no_assigned_pm(self):
        self.project.project_manager = None
        self.project.save(update_fields=['project_manager'])
        interaction = self._note(f'#{self.phase2_task.id} needs a PM.', self.manager)
        self.assertFalse(Mention.objects.filter(interaction=interaction).exists())

    def test_multiple_task_references_each_create_their_own_mention(self):
        interaction = self._note(
            f'#{self.phase1_task.id} and #{self.phase2_task.id} both need eyes.', self.manager,
        )
        mentions = {m.task_id: m.user_id for m in Mention.objects.filter(interaction=interaction)}
        self.assertEqual(mentions, {self.phase1_task.id: self.rep.id, self.phase2_task.id: self.pm.id})

    def test_user_mention_and_task_reference_to_the_same_person_both_create_mentions(self):
        # @rep1 by name AND #<phase1_task> (the rep's own task) in one note --
        # two distinct reasons to notify the same person, not a collision
        # with the (user, interaction, task) uniqueness.
        interaction = self._note(f'@{self.rep.username} re: #{self.phase1_task.id}', self.manager)
        self.assertEqual(Mention.objects.filter(interaction=interaction, user=self.rep).count(), 2)
        self.assertTrue(Mention.objects.filter(interaction=interaction, user=self.rep, task__isnull=True).exists())
        self.assertTrue(
            Mention.objects.filter(interaction=interaction, user=self.rep, task=self.phase1_task).exists(),
        )

    def test_resaving_does_not_duplicate_the_task_mention(self):
        interaction = self._note(f'#{self.phase1_task.id}', self.manager)
        interaction.save()
        interaction.save()
        self.assertEqual(
            Mention.objects.filter(interaction=interaction, task=self.phase1_task, user=self.rep).count(), 1,
        )


class TaskReferenceApiTests(ProjectRequirementsTestMixin, APITestCase):
    """
    referenced_tasks on InteractionSerializer renders any "#<id>" regardless
    of who wrote it or whether it notified anyone; a task-tag notification's
    payload names the task; and a PM can now log an interaction (needed to
    tag a task at all) on a project they manage, but not elsewhere.
    """

    def setUp(self):
        super().setUp()
        self.phase1_task = self.project.requirements.filter(phase=1).first()
        self.phase2_task = self.project.requirements.filter(phase=2).first()

    def test_referenced_tasks_appear_even_when_the_rep_tags_their_own_task(self):
        self.client.force_authenticate(self.rep)
        response = self.client.post(reverse('interaction-list'), {
            'lead': self.lead.id, 'type': Interaction.Type.NOTE,
            'notes': f'Working on #{self.phase1_task.id} now.',
        }, format='json')
        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        self.assertEqual(response.data['referenced_tasks'], [{'id': self.phase1_task.id, 'label': self.phase1_task.label}])
        # Rendered, but never a notification -- a rep's own tag isn't one.
        self.assertFalse(Mention.objects.filter(interaction=response.data['id']).exists())

    def test_referenced_tasks_omits_unknown_ids(self):
        response = self.client.post(reverse('interaction-list'), {
            'lead': self.lead.id, 'type': Interaction.Type.NOTE, 'notes': 'See #999999 please.',
        }, format='json')
        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        self.assertEqual(response.data['referenced_tasks'], [])

    def test_notification_payload_for_a_task_tag_includes_the_task(self):
        self.client.post(reverse('interaction-list'), {
            'lead': self.lead.id, 'type': Interaction.Type.NOTE,
            'notes': f'Please review #{self.phase2_task.id}.',
        }, format='json')

        self.client.force_authenticate(self.pm)
        response = self.client.get(reverse('notification-list'))
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        row = next(r for r in response.data if r['task'] == self.phase2_task.id)
        self.assertEqual(row['task_label'], self.phase2_task.label)

    def test_plain_mention_notification_has_no_task(self):
        self.client.post(reverse('interaction-list'), {
            'lead': self.lead.id, 'type': Interaction.Type.NOTE, 'notes': f'cc @{self.rep.username}',
        }, format='json')

        self.client.force_authenticate(self.rep)
        response = self.client.get(reverse('notification-list'))
        row = response.data[0]
        self.assertIsNone(row['task'])
        self.assertIsNone(row['task_label'])

    def test_pm_can_log_an_interaction_on_a_project_they_manage(self):
        self.client.force_authenticate(self.pm)
        response = self.client.post(reverse('interaction-list'), {
            'lead': self.lead.id, 'type': Interaction.Type.NOTE, 'notes': f'#{self.phase2_task.id} in progress.',
        }, format='json')
        self.assertEqual(response.status_code, status.HTTP_201_CREATED)

    def test_pm_cannot_log_an_interaction_on_a_project_they_do_not_manage(self):
        other_pm = User.objects.create_user(username='pm2', password='pass', role=User.Role.PROJECT_MANAGER)
        self.client.force_authenticate(other_pm)
        response = self.client.post(reverse('interaction-list'), {
            'lead': self.lead.id, 'type': Interaction.Type.NOTE, 'notes': 'Not my project.',
        }, format='json')
        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)


class NotificationApiTests(APITestCase):
    def setUp(self):
        self.rep1 = User.objects.create_user(username='rep1', password='pass', role=User.Role.SALES_REP)
        self.rep2 = User.objects.create_user(username='rep2', password='pass', role=User.Role.SALES_REP)
        self.rep3 = User.objects.create_user(username='rep3', password='pass', role=User.Role.SALES_REP)
        self.company = Company.objects.create(name='Acme', owner=self.rep1)
        self.lead = Lead.objects.create(company=self.company, assigned_to=self.rep1)
        self.client.force_authenticate(self.rep1)

    def _mention(self, target_username, author=None):
        interaction = Interaction.objects.create(
            lead=self.lead, type=Interaction.Type.NOTE,
            notes=f'cc @{target_username} for visibility', created_by=author or self.rep1,
        )
        return Mention.objects.get(interaction=interaction)

    def test_notification_list_only_returns_the_current_users_unread_mentions(self):
        mine = self._mention('rep2')
        self._mention('rep3')  # someone else's mention -- must not appear

        self.client.force_authenticate(self.rep2)
        response = self.client.get(reverse('notification-list'))
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        ids = [row['id'] for row in response.data]
        self.assertEqual(ids, [mine.id])

    def test_notification_payload_includes_interaction_lead_and_author(self):
        self._mention('rep2', author=self.rep1)
        self.client.force_authenticate(self.rep2)
        response = self.client.get(reverse('notification-list'))
        row = response.data[0]
        self.assertEqual(row['lead_id'], self.lead.id)
        self.assertEqual(row['lead_name'], self.lead.name)
        self.assertEqual(row['created_by_username'], 'rep1')
        self.assertIn('cc @rep2 for visibility', row['note_snippet'])
        self.assertIn('interaction', row)

    def test_read_mentions_are_excluded_from_the_list(self):
        mention = self._mention('rep2')
        mention.read_at = timezone.now()
        mention.save(update_fields=['read_at'])

        self.client.force_authenticate(self.rep2)
        response = self.client.get(reverse('notification-list'))
        self.assertEqual(response.data, [])

    def test_marking_one_mention_read(self):
        mention = self._mention('rep2')
        self.client.force_authenticate(self.rep2)

        url = reverse('notification-detail', args=[mention.id])
        response = self.client.patch(url, {}, format='json')
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertIsNotNone(response.data['read_at'])

        mention.refresh_from_db()
        self.assertIsNotNone(mention.read_at)

        list_response = self.client.get(reverse('notification-list'))
        self.assertEqual(list_response.data, [])

    def test_marking_an_already_read_mention_again_is_a_harmless_no_op(self):
        mention = self._mention('rep2')
        self.client.force_authenticate(self.rep2)
        url = reverse('notification-detail', args=[mention.id])

        first = self.client.patch(url, {}, format='json')
        self.assertEqual(first.status_code, status.HTTP_200_OK)
        first_read_at = mention.__class__.objects.get(pk=mention.id).read_at

        second = self.client.patch(url, {}, format='json')
        self.assertEqual(second.status_code, status.HTTP_200_OK)
        mention.refresh_from_db()
        self.assertEqual(mention.read_at, first_read_at)

    def test_cannot_mark_someone_elses_mention_read(self):
        mention = self._mention('rep2')
        self.client.force_authenticate(self.rep3)
        url = reverse('notification-detail', args=[mention.id])
        response = self.client.patch(url, {}, format='json')
        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)
        mention.refresh_from_db()
        self.assertIsNone(mention.read_at)

    def test_unread_count_reflects_only_this_users_unread_mentions(self):
        self._mention('rep2')
        self._mention('rep2')
        self._mention('rep3')

        self.client.force_authenticate(self.rep2)
        response = self.client.get(reverse('notification-unread-count'))
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.data['unread_count'], 2)

    def test_mark_all_read_clears_every_unread_mention_for_this_user(self):
        self._mention('rep2')
        self._mention('rep2')
        other_mention = self._mention('rep3')

        self.client.force_authenticate(self.rep2)
        response = self.client.post(reverse('notification-mark-all-read'))
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.data['unread_count'], 0)

        self.assertEqual(
            Mention.objects.filter(user=self.rep2, read_at__isnull=True).count(), 0,
        )
        # Someone else's unread mention is untouched.
        other_mention.refresh_from_db()
        self.assertIsNone(other_mention.read_at)

    def test_unauthenticated_request_is_rejected(self):
        self.client.force_authenticate(None)
        response = self.client.get(reverse('notification-list'))
        self.assertEqual(response.status_code, status.HTTP_401_UNAUTHORIZED)


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


class TaskCompletionAuthorityTests(ProjectRequirementsTestMixin, APITestCase):
    """
    Who may move a task's status INTO Completed: the assigned rep for Phase
    1/4, the assigned PM for Phase 2/3. Management roles never complete a
    task directly -- they read, confirm MANAGER-authority tasks someone else
    completed, and edit metadata, but completion itself is off-limits.
    """

    def setUp(self):
        super().setUp()
        self.other_pm = User.objects.create_user(username='pm2', password='pass', role=User.Role.PROJECT_MANAGER)
        self.exec_manager = User.objects.create_user(
            username='exec1', password='pass', role=User.Role.EXECUTIVE_MANAGER,
        )
        self.admin = User.objects.create_user(username='admin1', password='pass', role=User.Role.SYSTEM_ADMIN)
        self.phase1_task = self.project.requirements.filter(phase=1).first()
        self.phase2_task = self.project.requirements.filter(phase=2).first()
        self.phase3_task = self.project.requirements.filter(phase=3).first()
        # 'Handover Note' specifically -- unlike 'Client Acceptance' (also
        # phase 4), it has no required form fields, so completing it in these
        # tests exercises only the completion-authority gate, not the
        # required-fields one.
        self.phase4_task = self.project.requirements.get(phase=4, label='Handover Note')

    def _complete(self, task, actor):
        self.client.force_authenticate(actor)
        url = reverse('phaserequirement-detail', args=[task.id])
        return self.client.patch(url, {'status': PhaseRequirement.Status.COMPLETED}, format='json')

    # -- rejections -----------------------------------------------------------

    def test_sales_manager_cannot_complete_any_task(self):
        for task in (self.phase1_task, self.phase2_task, self.phase3_task, self.phase4_task):
            response = self._complete(task, self.manager)
            self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST, task.label)
            self.assertIn('status', response.data)
            task.refresh_from_db()
            self.assertNotEqual(task.status, PhaseRequirement.Status.COMPLETED)

    def test_executive_manager_cannot_complete_any_task(self):
        response = self._complete(self.phase1_task, self.exec_manager)
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)

    def test_system_admin_cannot_complete_any_task(self):
        response = self._complete(self.phase1_task, self.admin)
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)

    def test_pm_cannot_complete_a_phase_1_task(self):
        response = self._complete(self.phase1_task, self.pm)
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn('sales rep', response.data['status'][0])
        self.phase1_task.refresh_from_db()
        self.assertNotEqual(self.phase1_task.status, PhaseRequirement.Status.COMPLETED)

    def test_pm_cannot_complete_a_phase_4_task(self):
        response = self._complete(self.phase4_task, self.pm)
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)

    def test_rep_cannot_complete_a_phase_2_task(self):
        response = self._complete(self.phase2_task, self.rep)
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn('project manager', response.data['status'][0])
        self.phase2_task.refresh_from_db()
        self.assertNotEqual(self.phase2_task.status, PhaseRequirement.Status.COMPLETED)

    def test_rep_cannot_complete_a_phase_3_task(self):
        response = self._complete(self.phase3_task, self.rep)
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)

    def test_unrelated_pm_cannot_complete_a_phase_2_task(self):
        # A real PM, just not the one assigned to this project -- scoped out
        # of the queryset entirely (PhaseRequirementPermission), so this is a
        # 404 like any other unrelated object in this codebase, not a 400
        # from the completion-authority check (which never gets reached).
        response = self._complete(self.phase2_task, self.other_pm)
        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)

    def test_unrelated_rep_cannot_complete_a_phase_1_task(self):
        other_rep = User.objects.create_user(username='rep2', password='pass', role=User.Role.SALES_REP)
        response = self._complete(self.phase1_task, other_rep)
        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)

    # -- allowed completions ----------------------------------------------------

    def test_assigned_rep_can_complete_phase_1_and_4_tasks(self):
        for task in (self.phase1_task, self.phase4_task):
            response = self._complete(task, self.rep)
            self.assertEqual(response.status_code, status.HTTP_200_OK, task.label)
            task.refresh_from_db()
            self.assertEqual(task.status, PhaseRequirement.Status.COMPLETED)

    def test_assigned_pm_can_complete_phase_2_and_3_tasks(self):
        for task in (self.phase2_task, self.phase3_task):
            response = self._complete(task, self.pm)
            self.assertEqual(response.status_code, status.HTTP_200_OK, task.label)
            task.refresh_from_db()
            self.assertEqual(task.status, PhaseRequirement.Status.COMPLETED)

    # -- completion and confirmation stay separate ---------------------------

    def test_completing_does_not_also_confirm_even_when_completer_could_confirm(self):
        # The Phase 2 task's confirmation_authority is PROJECT_MANAGER, and
        # the assigned PM (the only one who can complete it) would also be
        # an eligible confirmer -- completing it still must not auto-confirm.
        self.assertEqual(self.phase2_task.confirmation_authority, PhaseRequirement.ConfirmationAuthority.PROJECT_MANAGER)
        response = self._complete(self.phase2_task, self.pm)
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.phase2_task.refresh_from_db()
        self.assertEqual(self.phase2_task.status, PhaseRequirement.Status.COMPLETED)
        self.assertIsNone(self.phase2_task.confirmed_by)

    def test_confirmation_path_still_works_for_managers(self):
        # Someone else (the assigned PM, per phase) completes it first --
        # confirmation is a genuinely separate, later action.
        self._complete(self.phase2_task, self.pm)
        self.phase2_task.refresh_from_db()
        self.assertIsNone(self.phase2_task.confirmed_by)

        self.client.force_authenticate(self.manager)
        url = reverse('phaserequirement-detail', args=[self.phase2_task.id])
        response = self.client.patch(url, {'status': PhaseRequirement.Status.COMPLETED}, format='json')
        self.assertEqual(response.status_code, status.HTTP_200_OK)

        self.phase2_task.refresh_from_db()
        self.assertEqual(self.phase2_task.confirmed_by, self.manager)
        self.assertIsNotNone(self.phase2_task.confirmed_at)
        self.assertTrue(self.phase2_task.is_confirmed_complete)

    # -- management roles retain everything except completion -----------------

    def test_manager_can_still_edit_task_notes_and_committed_date(self):
        url = reverse('phaserequirement-detail', args=[self.phase1_task.id])
        response = self.client.patch(
            url, {'notes': 'Called client, rescheduling.', 'committed_date': '2026-03-01'}, format='json',
        )
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.phase1_task.refresh_from_db()
        self.assertEqual(self.phase1_task.notes, 'Called client, rescheduling.')
        self.assertEqual(str(self.phase1_task.committed_date), '2026-03-01')

    def test_manager_can_still_read_any_task(self):
        for task in (self.phase1_task, self.phase2_task, self.phase3_task, self.phase4_task):
            url = reverse('phaserequirement-detail', args=[task.id])
            response = self.client.get(url)
            self.assertEqual(response.status_code, status.HTTP_200_OK)


class CustomTaskTests(ProjectRequirementsTestMixin, APITestCase):
    def setUp(self):
        super().setUp()
        self.other_rep = User.objects.create_user(username='rep2', password='pass', role=User.Role.SALES_REP)
        self.other_pm = User.objects.create_user(username='pm2', password='pass', role=User.Role.PROJECT_MANAGER)

    def _payload(self, phase=2, **overrides):
        payload = {
            'project': self.project.id,
            'phase': phase,
            'label': 'Custom onboarding call',
            'description': 'Walk the client through the new dashboard.',
            'confirmation_authority': 'REP',
        }
        payload.update(overrides)
        return payload

    # -- creation scoping ---------------------------------------------------

    def test_assigned_rep_can_create_custom_task(self):
        self.client.force_authenticate(self.rep)
        response = self.client.post(reverse('phaserequirement-list'), self._payload(), format='json')
        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        self.assertTrue(response.data['is_custom'])
        self.assertEqual(response.data['created_by'], self.rep.id)

    def test_unrelated_rep_cannot_create_custom_task(self):
        self.client.force_authenticate(self.other_rep)
        response = self.client.post(reverse('phaserequirement-list'), self._payload(), format='json')
        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)

    def test_managing_pm_can_create_custom_task(self):
        self.client.force_authenticate(self.pm)
        response = self.client.post(reverse('phaserequirement-list'), self._payload(), format='json')
        self.assertEqual(response.status_code, status.HTTP_201_CREATED)

    def test_unrelated_pm_cannot_create_custom_task(self):
        self.client.force_authenticate(self.other_pm)
        response = self.client.post(reverse('phaserequirement-list'), self._payload(), format='json')
        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)

    def test_manager_can_create_custom_task_anywhere(self):
        self.client.force_authenticate(self.manager)
        response = self.client.post(reverse('phaserequirement-list'), self._payload(), format='json')
        self.assertEqual(response.status_code, status.HTTP_201_CREATED)

    # -- delete restricted to custom -----------------------------------------

    def test_custom_task_can_be_deleted_by_creator(self):
        self.client.force_authenticate(self.rep)
        create = self.client.post(reverse('phaserequirement-list'), self._payload(), format='json')
        self.assertEqual(create.status_code, status.HTTP_201_CREATED)

        url = reverse('phaserequirement-detail', args=[create.data['id']])
        response = self.client.delete(url)
        self.assertEqual(response.status_code, status.HTTP_204_NO_CONTENT)
        self.assertFalse(PhaseRequirement.objects.filter(pk=create.data['id']).exists())

    def test_template_derived_task_cannot_be_deleted(self):
        requirement = self.project.requirements.filter(phase=1).first()
        self.client.force_authenticate(self.manager)
        url = reverse('phaserequirement-detail', args=[requirement.id])
        response = self.client.delete(url)
        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)
        self.assertTrue(PhaseRequirement.objects.filter(pk=requirement.pk).exists())

    def test_unrelated_rep_cannot_delete_a_custom_task_even_though_it_is_custom(self):
        self.client.force_authenticate(self.manager)
        create = self.client.post(reverse('phaserequirement-list'), self._payload(), format='json')
        self.assertEqual(create.status_code, status.HTTP_201_CREATED)

        self.client.force_authenticate(self.other_rep)
        url = reverse('phaserequirement-detail', args=[create.data['id']])
        response = self.client.delete(url)
        # Not in this rep's queryset at all (get_queryset scopes them to their
        # own assigned lead's project) -- 404, same as any other unrelated
        # object in this codebase, not 403.
        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)
        self.assertTrue(PhaseRequirement.objects.filter(pk=create.data['id']).exists())

    # -- progress inclusion ---------------------------------------------------

    def test_custom_task_counts_toward_phase_progress(self):
        self.client.force_authenticate(self.manager)
        before = self.client.get(reverse('project-detail', args=[self.project.id]))
        before_total = before.data['phase_progress'][2]['total']

        create = self.client.post(reverse('phaserequirement-list'), self._payload(phase=2), format='json')
        self.assertEqual(create.status_code, status.HTTP_201_CREATED)

        after = self.client.get(reverse('project-detail', args=[self.project.id]))
        self.assertEqual(after.data['phase_progress'][2]['total'], before_total + 1)
        self.assertEqual(after.data['phase_progress'][2]['completed'], 0)

        complete_url = reverse('phaserequirement-detail', args=[create.data['id']])
        # Phase 2 -- only the assigned PM may complete it.
        self.client.force_authenticate(self.pm)
        complete_response = self.client.patch(complete_url, {'status': 'COMPLETED'}, format='json')
        self.assertEqual(complete_response.status_code, status.HTTP_200_OK)

        final = self.client.get(reverse('project-detail', args=[self.project.id]))
        self.assertEqual(final.data['phase_progress'][2]['completed'], 1)


class TaskAttachmentTests(ProjectRequirementsTestMixin, APITestCase):
    def setUp(self):
        super().setUp()
        self.other_rep = User.objects.create_user(username='rep2', password='pass', role=User.Role.SALES_REP)
        self.other_pm = User.objects.create_user(username='pm2', password='pass', role=User.Role.PROJECT_MANAGER)
        self.requirement = self.project.requirements.first()

    @staticmethod
    def _pdf_file(name='doc.pdf', size=None):
        content = b'%PDF-1.4 test content'
        if size is not None:
            content = b'0' * size
        return SimpleUploadedFile(name, content, content_type='application/pdf')

    def _upload(self, **overrides):
        payload = {'requirement': self.requirement.id, 'kind': 'FILE', 'file': self._pdf_file()}
        payload.update(overrides)
        return self.client.post(reverse('taskattachment-list'), payload, format='multipart')

    # -- upload validation ----------------------------------------------------

    def test_valid_pdf_upload_succeeds(self):
        self.client.force_authenticate(self.rep)
        response = self._upload()
        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        attachment = TaskAttachment.objects.get(pk=response.data['id'])
        self.assertEqual(attachment.content_type, 'application/pdf')
        self.assertEqual(attachment.uploaded_by, self.rep)
        self.assertEqual(attachment.original_filename, 'doc.pdf')

    def test_oversized_file_is_rejected(self):
        self.client.force_authenticate(self.rep)
        big_file = self._pdf_file(size=16 * 1024 * 1024)
        response = self._upload(file=big_file)
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn('file', response.data)
        self.assertEqual(TaskAttachment.objects.count(), 0)

    def test_unsupported_content_type_is_rejected(self):
        self.client.force_authenticate(self.rep)
        exe_file = SimpleUploadedFile('tool.exe', b'not really an exe', content_type='application/x-msdownload')
        response = self._upload(file=exe_file)
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn('file', response.data)
        self.assertEqual(TaskAttachment.objects.count(), 0)

    def test_docx_content_type_is_accepted(self):
        self.client.force_authenticate(self.rep)
        docx_file = SimpleUploadedFile(
            'spec.docx', b'docx bytes',
            content_type='application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        )
        response = self._upload(file=docx_file)
        self.assertEqual(response.status_code, status.HTTP_201_CREATED)

    def test_file_kind_without_file_is_rejected(self):
        self.client.force_authenticate(self.rep)
        response = self.client.post(reverse('taskattachment-list'), {
            'requirement': self.requirement.id,
            'kind': 'FILE',
        }, format='multipart')
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)

    def test_link_requires_url_and_title(self):
        self.client.force_authenticate(self.rep)
        response = self.client.post(reverse('taskattachment-list'), {
            'requirement': self.requirement.id,
            'kind': 'LINK',
        }, format='json')
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn('url', response.data)
        self.assertIn('title', response.data)

    def test_valid_link_upload_succeeds(self):
        self.client.force_authenticate(self.rep)
        response = self.client.post(reverse('taskattachment-list'), {
            'requirement': self.requirement.id,
            'kind': 'LINK',
            'url': 'https://docs.google.com/forms/d/e/abc123/viewform',
            'title': 'Intake form',
        }, format='json')
        self.assertEqual(response.status_code, status.HTTP_201_CREATED)

    def test_link_with_file_is_rejected(self):
        self.client.force_authenticate(self.rep)
        response = self.client.post(reverse('taskattachment-list'), {
            'requirement': self.requirement.id,
            'kind': 'LINK',
            'url': 'https://example.com',
            'title': 'Example',
            'file': self._pdf_file(),
        }, format='multipart')
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)

    # -- download permission scoping -------------------------------------------

    def test_assigned_rep_can_download(self):
        self.client.force_authenticate(self.rep)
        create = self._upload()
        url = reverse('taskattachment-download', args=[create.data['id']])
        response = self.client.get(url)
        self.assertEqual(response.status_code, status.HTTP_200_OK)

    def test_unrelated_rep_cannot_download(self):
        self.client.force_authenticate(self.rep)
        create = self._upload()

        self.client.force_authenticate(self.other_rep)
        url = reverse('taskattachment-download', args=[create.data['id']])
        response = self.client.get(url)
        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)

    def test_managing_pm_can_download(self):
        self.client.force_authenticate(self.pm)
        create = self._upload()
        url = reverse('taskattachment-download', args=[create.data['id']])
        response = self.client.get(url)
        self.assertEqual(response.status_code, status.HTTP_200_OK)

    def test_unrelated_pm_cannot_download(self):
        self.client.force_authenticate(self.rep)
        create = self._upload()

        self.client.force_authenticate(self.other_pm)
        url = reverse('taskattachment-download', args=[create.data['id']])
        response = self.client.get(url)
        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)

    def test_management_can_download(self):
        self.client.force_authenticate(self.rep)
        create = self._upload()

        self.client.force_authenticate(self.manager)
        url = reverse('taskattachment-download', args=[create.data['id']])
        response = self.client.get(url)
        self.assertEqual(response.status_code, status.HTTP_200_OK)

    def test_file_field_never_appears_in_api_responses(self):
        self.client.force_authenticate(self.rep)
        create = self._upload()
        self.assertNotIn('file', create.data)

        detail = self.client.get(reverse('taskattachment-detail', args=[create.data['id']]))
        self.assertNotIn('file', detail.data)

    def test_cannot_reach_the_file_via_a_raw_media_url(self):
        # The whole point of PrivateAttachmentStorage: the file lives outside
        # MEDIA_ROOT entirely, so django.views.static.serve (wired up for
        # MEDIA_ROOT in config/urls.py whenever DEBUG is on) can never find
        # it, regardless of authentication.
        self.client.force_authenticate(self.rep)
        create = self._upload()
        attachment = TaskAttachment.objects.get(pk=create.data['id'])

        self.assertTrue(str(attachment.file.path).startswith(str(settings.PRIVATE_MEDIA_ROOT)))
        self.assertFalse(str(attachment.file.path).startswith(str(settings.MEDIA_ROOT)))
        with self.assertRaises(Exception):
            _ = attachment.file.url

        guessed_media_url = f'{settings.MEDIA_URL}{attachment.file.name}'
        # Unauthenticated on top of it -- doubly shouldn't work.
        anonymous_client = APIClient()
        response = anonymous_client.get(guessed_media_url)
        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)

    # -- delete restriction -----------------------------------------------------

    def test_uploader_can_delete_own_attachment(self):
        self.client.force_authenticate(self.rep)
        create = self._upload()
        url = reverse('taskattachment-detail', args=[create.data['id']])
        response = self.client.delete(url)
        self.assertEqual(response.status_code, status.HTTP_204_NO_CONTENT)

    def test_manager_can_delete_anyones_attachment(self):
        self.client.force_authenticate(self.rep)
        create = self._upload()

        self.client.force_authenticate(self.manager)
        url = reverse('taskattachment-detail', args=[create.data['id']])
        response = self.client.delete(url)
        self.assertEqual(response.status_code, status.HTTP_204_NO_CONTENT)

    def test_assigned_pm_who_did_not_upload_cannot_delete(self):
        # PM manages this project (and so can edit the task/upload their own
        # attachments), but didn't upload this particular one -- delete is
        # narrower than "can edit the task".
        self.client.force_authenticate(self.rep)
        create = self._upload()

        self.client.force_authenticate(self.pm)
        url = reverse('taskattachment-detail', args=[create.data['id']])
        response = self.client.delete(url)
        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)
        self.assertTrue(TaskAttachment.objects.filter(pk=create.data['id']).exists())

    def test_assigned_rep_who_did_not_upload_cannot_delete(self):
        self.client.force_authenticate(self.manager)
        create = self._upload()

        self.client.force_authenticate(self.rep)
        url = reverse('taskattachment-detail', args=[create.data['id']])
        response = self.client.delete(url)
        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)
        self.assertTrue(TaskAttachment.objects.filter(pk=create.data['id']).exists())


class TaskFormFieldTests(ProjectRequirementsTestMixin, APITestCase):
    """
    Template-derived form fields (Requirement Discussion / Budget Proposal,
    seeded by migration 0022 onto the templates migration 0019 reseeds) are
    exposed by reference through PhaseRequirement.form_fields -- these tests
    exercise the answers action, the completion gate, and that a PATCH that
    doesn't touch status/fields never disturbs saved responses.
    """

    def setUp(self):
        super().setUp()
        self.requirement = self.project.requirements.filter(phase=1, label='Requirement Discussion').first()
        self.answers_url = reverse('phaserequirement-answers', args=[self.requirement.id])
        self.detail_url = reverse('phaserequirement-detail', args=[self.requirement.id])

    def _field_id(self, label):
        return next(f.id for f in self.requirement.form_fields if f.label == label)

    def test_generated_task_exposes_the_templates_fields_by_reference(self):
        other_lead = Lead.objects.create(company=self.company, contact=self.contact, assigned_to=self.rep)
        other_requirement = other_lead.project.requirements.filter(phase=1, label='Requirement Discussion').first()

        self.assertEqual(self.requirement.template_id, other_requirement.template_id)
        self.assertEqual(
            {f.id for f in self.requirement.form_fields},
            {f.id for f in other_requirement.form_fields},
        )
        # Not copies -- the same underlying TaskFormField rows, so there's
        # still exactly one set of fields per template regardless of how many
        # projects/tasks reference it.
        self.assertEqual(TaskFormField.objects.filter(template_id=self.requirement.template_id).count(), 4)

    def test_cannot_complete_task_with_missing_required_fields(self):
        # Phase 1 -- only the assigned rep may complete it; authenticating as
        # them isolates this test to the required-fields gate specifically.
        self.client.force_authenticate(self.rep)
        response = self.client.patch(self.detail_url, {'status': PhaseRequirement.Status.COMPLETED}, format='json')
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        for label in ('Meeting date', 'Attendees', 'Key requirements captured'):
            self.assertIn(label, response.data['status'][0])
        self.requirement.refresh_from_db()
        self.assertEqual(self.requirement.status, PhaseRequirement.Status.PENDING)

    def test_naming_only_the_fields_still_missing(self):
        self.client.post(self.answers_url, {
            'responses': [{'field': self._field_id('Meeting date'), 'value': '2026-01-01'}],
        }, format='json')

        self.client.force_authenticate(self.rep)
        response = self.client.patch(self.detail_url, {'status': PhaseRequirement.Status.COMPLETED}, format='json')
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertNotIn('Meeting date', response.data['status'][0])
        self.assertIn('Attendees', response.data['status'][0])
        self.assertIn('Key requirements captured', response.data['status'][0])

    def test_can_complete_once_all_required_fields_are_answered(self):
        self.client.post(self.answers_url, {
            'responses': [
                {'field': self._field_id('Meeting date'), 'value': '2026-01-01'},
                {'field': self._field_id('Attendees'), 'value': 'Jane Doe'},
                {'field': self._field_id('Key requirements captured'), 'value': 'SSO integration.'},
            ],
        }, format='json')

        self.client.force_authenticate(self.rep)
        response = self.client.patch(self.detail_url, {'status': PhaseRequirement.Status.COMPLETED}, format='json')
        self.assertEqual(response.status_code, status.HTTP_200_OK)

    def test_unrequired_field_left_blank_does_not_block_completion(self):
        # "Follow-up needed" (CHECKBOX) is the one non-required field on this
        # form -- leaving it unanswered must not block completion.
        self.client.post(self.answers_url, {
            'responses': [
                {'field': self._field_id('Meeting date'), 'value': '2026-01-01'},
                {'field': self._field_id('Attendees'), 'value': 'Jane Doe'},
                {'field': self._field_id('Key requirements captured'), 'value': 'SSO integration.'},
            ],
        }, format='json')
        self.client.force_authenticate(self.rep)
        response = self.client.patch(self.detail_url, {'status': PhaseRequirement.Status.COMPLETED}, format='json')
        self.assertEqual(response.status_code, status.HTTP_200_OK)

    def test_answering_a_field_records_an_activity_event(self):
        response = self.client.post(self.answers_url, {
            'responses': [{'field': self._field_id('Attendees'), 'value': 'Jane Doe'}],
        }, format='json')
        self.assertEqual(response.status_code, status.HTTP_200_OK)

        event = ActivityEvent.objects.get(lead=self.lead, category=ActivityEvent.Category.PHASE)
        self.assertIn('Attendees', event.description)
        self.assertEqual(event.actor, self.manager)

    def test_re_answering_a_field_updates_rather_than_duplicates(self):
        field_id = self._field_id('Attendees')
        self.client.post(self.answers_url, {'responses': [{'field': field_id, 'value': 'Jane Doe'}]}, format='json')
        response = self.client.post(
            self.answers_url, {'responses': [{'field': field_id, 'value': 'Jane Doe, John Smith'}]}, format='json',
        )
        self.assertEqual(response.status_code, status.HTTP_200_OK)

        self.assertEqual(TaskFormResponse.objects.filter(requirement=self.requirement, field_id=field_id).count(), 1)
        saved = TaskFormResponse.objects.get(requirement=self.requirement, field_id=field_id)
        self.assertEqual(saved.value, 'Jane Doe, John Smith')

        # Two edits to the same field -> two events (one per changed save),
        # not deduplicated -- each is a real audit entry.
        self.assertEqual(
            ActivityEvent.objects.filter(lead=self.lead, category=ActivityEvent.Category.PHASE).count(), 2,
        )

    def test_resaving_the_same_value_does_not_record_a_second_event(self):
        field_id = self._field_id('Attendees')
        self.client.post(self.answers_url, {'responses': [{'field': field_id, 'value': 'Jane Doe'}]}, format='json')
        self.client.post(self.answers_url, {'responses': [{'field': field_id, 'value': 'Jane Doe'}]}, format='json')
        self.assertEqual(
            ActivityEvent.objects.filter(lead=self.lead, category=ActivityEvent.Category.PHASE).count(), 1,
        )

    def test_answers_response_includes_saved_responses_not_a_stale_cache(self):
        field_id = self._field_id('Attendees')
        response = self.client.post(self.answers_url, {
            'responses': [{'field': field_id, 'value': 'Jane Doe'}],
        }, format='json')
        saved = next(r for r in response.data['form_responses'] if r['field'] == field_id)
        self.assertEqual(saved['value'], 'Jane Doe')

    def test_answer_for_field_not_belonging_to_task_is_rejected(self):
        other_requirement = self.project.requirements.filter(phase=2, label='Budget Proposal').first()
        foreign_field_id = next(f.id for f in other_requirement.form_fields)
        response = self.client.post(self.answers_url, {
            'responses': [{'field': foreign_field_id, 'value': 'x'}],
        }, format='json')
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertFalse(TaskFormResponse.objects.filter(requirement=self.requirement).exists())

    def test_responses_survive_an_unrelated_patch(self):
        field_id = self._field_id('Attendees')
        self.client.post(self.answers_url, {'responses': [{'field': field_id, 'value': 'Jane Doe'}]}, format='json')

        response = self.client.patch(self.detail_url, {'notes': 'Rescheduled once.'}, format='json')
        self.assertEqual(response.status_code, status.HTTP_200_OK)

        saved = TaskFormResponse.objects.get(requirement=self.requirement, field_id=field_id)
        self.assertEqual(saved.value, 'Jane Doe')

    def test_responses_survive_a_committed_date_patch(self):
        field_id = self._field_id('Attendees')
        self.client.post(self.answers_url, {'responses': [{'field': field_id, 'value': 'Jane Doe'}]}, format='json')

        response = self.client.patch(self.detail_url, {'committed_date': '2026-02-01'}, format='json')
        self.assertEqual(response.status_code, status.HTTP_200_OK)

        self.assertTrue(TaskFormResponse.objects.filter(requirement=self.requirement, field_id=field_id).exists())

    def test_responses_survive_task_completion(self):
        self.client.post(self.answers_url, {
            'responses': [
                {'field': self._field_id('Meeting date'), 'value': '2026-01-01'},
                {'field': self._field_id('Attendees'), 'value': 'Jane Doe'},
                {'field': self._field_id('Key requirements captured'), 'value': 'SSO integration.'},
            ],
        }, format='json')
        self.client.force_authenticate(self.rep)
        response = self.client.patch(self.detail_url, {'status': PhaseRequirement.Status.COMPLETED}, format='json')
        self.assertEqual(response.status_code, status.HTTP_200_OK)

        self.assertEqual(
            TaskFormResponse.objects.filter(requirement=self.requirement).count(), 3,
        )


class RequirementTemplateFormFieldTests(APITestCase):
    """
    RequirementTemplateSerializer's nested, writable form_fields -- managers
    can add/edit/reorder/delete a template's fields via the same "resend the
    whole list" PATCH, matching TaskFormField's existing SELECT-options
    validation.
    """

    def setUp(self):
        self.manager = User.objects.create_user(username='mgr', password='pass', role=User.Role.SALES_MANAGER)
        self.admin = User.objects.create_user(username='admin1', password='pass', role=User.Role.SYSTEM_ADMIN)
        self.rep = User.objects.create_user(username='rep', password='pass', role=User.Role.SALES_REP)
        self.template = RequirementTemplate.objects.create(
            phase=1, label='Discovery Call', order=100, confirmation_authority='REP',
        )
        self.client.force_authenticate(self.manager)

    def _detail_url(self):
        return reverse('requirementtemplate-detail', args=[self.template.id])

    def test_creating_a_template_with_form_fields(self):
        response = self.client.post(reverse('requirementtemplate-list'), {
            'phase': 2, 'label': 'New Template', 'order': 100, 'confirmation_authority': 'PROJECT_MANAGER',
            'form_fields': [
                {'label': 'Est. hours', 'field_type': 'NUMBER', 'required': True, 'order': 1},
                {'label': 'Risk', 'field_type': 'SELECT', 'options': ['Low', 'High'], 'required': False, 'order': 2},
            ],
        }, format='json')
        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        template = RequirementTemplate.objects.get(pk=response.data['id'])
        self.assertEqual(template.form_fields.count(), 2)
        self.assertEqual(response.data['form_fields'][0]['label'], 'Est. hours')

    def test_select_field_without_options_is_rejected_on_create(self):
        response = self.client.post(reverse('requirementtemplate-list'), {
            'phase': 2, 'label': 'New Template', 'order': 100, 'confirmation_authority': 'REP',
            'form_fields': [{'label': 'Risk', 'field_type': 'SELECT', 'options': [], 'required': True, 'order': 1}],
        }, format='json')
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertFalse(RequirementTemplate.objects.filter(label='New Template').exists())

    def test_adding_a_field_to_an_existing_template(self):
        response = self.client.patch(self._detail_url(), {
            'form_fields': [{'label': 'Meeting notes', 'field_type': 'TEXTAREA', 'required': False, 'order': 1}],
        }, format='json')
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(self.template.form_fields.count(), 1)
        self.assertEqual(self.template.form_fields.get().label, 'Meeting notes')

    def test_editing_an_existing_field_in_place_does_not_duplicate_it(self):
        field = TaskFormField.objects.create(template=self.template, label='Old label', field_type='TEXT', order=1)
        response = self.client.patch(self._detail_url(), {
            'form_fields': [
                {'id': field.id, 'label': 'New label', 'field_type': 'TEXT', 'required': True, 'order': 1},
            ],
        }, format='json')
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(self.template.form_fields.count(), 1)
        field.refresh_from_db()
        self.assertEqual(field.label, 'New label')
        self.assertTrue(field.required)

    def test_reordering_fields(self):
        first = TaskFormField.objects.create(template=self.template, label='A', field_type='TEXT', order=1)
        second = TaskFormField.objects.create(template=self.template, label='B', field_type='TEXT', order=2)
        response = self.client.patch(self._detail_url(), {
            'form_fields': [
                {'id': first.id, 'label': 'A', 'field_type': 'TEXT', 'required': False, 'order': 2},
                {'id': second.id, 'label': 'B', 'field_type': 'TEXT', 'required': False, 'order': 1},
            ],
        }, format='json')
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        ordered_labels = list(self.template.form_fields.order_by('order').values_list('label', flat=True))
        self.assertEqual(ordered_labels, ['B', 'A'])

    def test_omitting_an_existing_field_deletes_it(self):
        keep = TaskFormField.objects.create(template=self.template, label='Keep', field_type='TEXT', order=1)
        TaskFormField.objects.create(template=self.template, label='Remove me', field_type='TEXT', order=2)
        response = self.client.patch(self._detail_url(), {
            'form_fields': [{'id': keep.id, 'label': 'Keep', 'field_type': 'TEXT', 'required': False, 'order': 1}],
        }, format='json')
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(list(self.template.form_fields.values_list('label', flat=True)), ['Keep'])

    def test_omitting_form_fields_entirely_leaves_existing_fields_untouched(self):
        TaskFormField.objects.create(template=self.template, label='Untouched', field_type='TEXT', order=1)
        response = self.client.patch(self._detail_url(), {'description': 'Updated description only.'}, format='json')
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(self.template.form_fields.count(), 1)

    def test_select_field_without_options_is_rejected_on_update(self):
        response = self.client.patch(self._detail_url(), {
            'form_fields': [{'label': 'Risk', 'field_type': 'SELECT', 'options': [], 'required': True, 'order': 1}],
        }, format='json')
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(self.template.form_fields.count(), 0)

    def test_system_admin_can_author_template_form_fields(self):
        self.client.force_authenticate(self.admin)
        response = self.client.patch(self._detail_url(), {
            'form_fields': [{'label': 'Notes', 'field_type': 'TEXT', 'required': False, 'order': 1}],
        }, format='json')
        self.assertEqual(response.status_code, status.HTTP_200_OK)

    def test_sales_rep_cannot_author_template_form_fields(self):
        self.client.force_authenticate(self.rep)
        response = self.client.patch(self._detail_url(), {
            'form_fields': [{'label': 'Notes', 'field_type': 'TEXT', 'required': False, 'order': 1}],
        }, format='json')
        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)
        self.assertEqual(self.template.form_fields.count(), 0)

    def test_sales_rep_can_still_read_template_form_fields(self):
        TaskFormField.objects.create(template=self.template, label='Visible', field_type='TEXT', order=1)
        self.client.force_authenticate(self.rep)
        response = self.client.get(self._detail_url())
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.data['form_fields'][0]['label'], 'Visible')


class ProjectBudgetPanelTests(ProjectRequirementsTestMixin, APITestCase):
    """
    proposed_budget/currency/notes on Project: the first two are normally set
    automatically when the Budget Proposal task's form completes (the
    "automatic pipeline updates from tasks" requirement), and are otherwise
    writable only by the managing PM and management roles; notes is writable
    by anyone who can edit the project at all.
    """

    def setUp(self):
        super().setUp()
        self.requirement = self.project.requirements.filter(phase=2, label='Budget Proposal').first()
        self.answers_url = reverse('phaserequirement-answers', args=[self.requirement.id])
        self.detail_url = reverse('phaserequirement-detail', args=[self.requirement.id])
        self.project_url = reverse('project-detail', args=[self.project.id])

    def _field_id(self, label):
        return next(f.id for f in self.requirement.form_fields if f.label == label)

    def _answer_budget_fields(self, amount='18500', currency='USD'):
        return self.client.post(self.answers_url, {
            'responses': [
                {'field': self._field_id('Proposed budget'), 'value': amount},
                {'field': self._field_id('Currency'), 'value': currency},
            ],
        }, format='json')

    # -- auto-population from the Budget Proposal form -------------------------

    def test_completing_budget_proposal_populates_project_budget(self):
        self._answer_budget_fields(amount='18500', currency='USD')
        # Phase 2 -- only the assigned PM may complete it.
        self.client.force_authenticate(self.pm)
        response = self.client.patch(self.detail_url, {'status': PhaseRequirement.Status.COMPLETED}, format='json')
        self.assertEqual(response.status_code, status.HTTP_200_OK)

        self.project.refresh_from_db()
        self.assertEqual(self.project.proposed_budget, Decimal('18500'))
        self.assertEqual(self.project.currency, 'USD')

    def test_completing_a_different_task_does_not_populate_budget(self):
        other = self.project.requirements.filter(phase=1, label='Requirement Discussion').first()
        fields = {f.label: f for f in other.form_fields}
        self.client.post(reverse('phaserequirement-answers', args=[other.id]), {
            'responses': [
                {'field': fields['Meeting date'].id, 'value': '2026-01-01'},
                {'field': fields['Attendees'].id, 'value': 'Jane Doe'},
                {'field': fields['Key requirements captured'].id, 'value': 'SSO integration.'},
            ],
        }, format='json')
        # Phase 1 -- only the assigned rep may complete it.
        self.client.force_authenticate(self.rep)
        response = self.client.patch(
            reverse('phaserequirement-detail', args=[other.id]),
            {'status': PhaseRequirement.Status.COMPLETED}, format='json',
        )
        self.assertEqual(response.status_code, status.HTTP_200_OK)

        self.project.refresh_from_db()
        self.assertIsNone(self.project.proposed_budget)
        self.assertEqual(self.project.currency, '')

    def test_re_saving_the_same_completed_status_does_not_re_trigger(self):
        # Auto-population only runs on an actual status transition -- editing
        # the saved answer afterwards and re-PATCHing the (unchanged) status
        # must not silently overwrite a value someone may have since edited
        # directly on the project.
        self._answer_budget_fields(amount='18500', currency='USD')
        self.client.force_authenticate(self.pm)
        self.client.patch(self.detail_url, {'status': PhaseRequirement.Status.COMPLETED}, format='json')

        self.client.post(self.answers_url, {
            'responses': [{'field': self._field_id('Proposed budget'), 'value': '99999'}],
        }, format='json')
        response = self.client.patch(self.detail_url, {'status': PhaseRequirement.Status.COMPLETED}, format='json')
        self.assertEqual(response.status_code, status.HTTP_200_OK)

        self.project.refresh_from_db()
        self.assertEqual(self.project.proposed_budget, Decimal('18500'))

    def test_non_numeric_budget_value_is_safely_ignored(self):
        self._answer_budget_fields(amount='not-a-number', currency='GBP')
        self.client.force_authenticate(self.pm)
        response = self.client.patch(self.detail_url, {'status': PhaseRequirement.Status.COMPLETED}, format='json')
        self.assertEqual(response.status_code, status.HTTP_200_OK)

        self.project.refresh_from_db()
        self.assertIsNone(self.project.proposed_budget)
        self.assertEqual(self.project.currency, 'GBP')

    # -- proposed_budget/currency: managing PM + management only ------------

    def test_managing_pm_can_write_budget_and_currency(self):
        self.client.force_authenticate(self.pm)
        response = self.client.patch(
            self.project_url, {'proposed_budget': '25000', 'currency': 'USD'}, format='json',
        )
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.project.refresh_from_db()
        self.assertEqual(self.project.proposed_budget, Decimal('25000'))
        self.assertEqual(self.project.currency, 'USD')

    def test_manager_can_write_budget_and_currency(self):
        self.client.force_authenticate(self.manager)
        response = self.client.patch(
            self.project_url, {'proposed_budget': '30000', 'currency': 'GBP'}, format='json',
        )
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.project.refresh_from_db()
        self.assertEqual(self.project.proposed_budget, Decimal('30000'))

    def test_assigned_rep_cannot_write_budget(self):
        # The rep still has general write access to the project (assigned to
        # its lead) -- the field itself is silently read-only for this role,
        # same convention as project_manager (see ProjectSerializer.__init__).
        self.client.force_authenticate(self.rep)
        response = self.client.patch(
            self.project_url, {'proposed_budget': '5000', 'currency': 'USD'}, format='json',
        )
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.project.refresh_from_db()
        self.assertIsNone(self.project.proposed_budget)
        self.assertEqual(self.project.currency, '')

    def test_unrelated_pm_cannot_write_budget(self):
        other_pm = User.objects.create_user(username='pm2', password='pass', role=User.Role.PROJECT_MANAGER)
        self.client.force_authenticate(other_pm)
        response = self.client.patch(self.project_url, {'proposed_budget': '5000'}, format='json')
        # Not the managing PM -- scoped out of the queryset entirely.
        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)

    def test_system_admin_cannot_write_budget_or_the_project_at_all(self):
        admin = User.objects.create_user(username='admin1', password='pass', role=User.Role.SYSTEM_ADMIN)
        self.client.force_authenticate(admin)
        response = self.client.patch(self.project_url, {'proposed_budget': '5000'}, format='json')
        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)

    # -- notes: writable by anyone who can edit the project ------------------

    def test_assigned_rep_can_write_notes(self):
        self.client.force_authenticate(self.rep)
        response = self.client.patch(self.project_url, {'notes': 'Client wants weekly updates.'}, format='json')
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.project.refresh_from_db()
        self.assertEqual(self.project.notes, 'Client wants weekly updates.')

    def test_managing_pm_can_write_notes(self):
        self.client.force_authenticate(self.pm)
        response = self.client.patch(self.project_url, {'notes': 'PM note.'}, format='json')
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.project.refresh_from_db()
        self.assertEqual(self.project.notes, 'PM note.')

    def test_manager_can_write_notes(self):
        self.client.force_authenticate(self.manager)
        response = self.client.patch(self.project_url, {'notes': 'Manager note.'}, format='json')
        self.assertEqual(response.status_code, status.HTTP_200_OK)

    def test_unrelated_rep_cannot_write_notes(self):
        other_rep = User.objects.create_user(username='rep2', password='pass', role=User.Role.SALES_REP)
        self.client.force_authenticate(other_rep)
        response = self.client.patch(self.project_url, {'notes': 'Should not save.'}, format='json')
        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)


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

    def test_phase_3_cannot_complete_without_approved_signoff(self):
        # Phase 3 now follows the exact same gate as 1/2/4 -- a direct PATCH
        # to COMPLETE fails without an approved PHASE_3_SIGNOFF, regardless of
        # execution status.
        self.project.phase_1_status = Project.PhaseStatus.COMPLETE
        self.project.phase_2_status = Project.PhaseStatus.COMPLETE
        self.project.phase_3_status = Project.PhaseStatus.IN_PROGRESS
        self.project.save()

        url = reverse('project-detail', args=[self.project.id])
        response = self.client.patch(url, {'phase_3_status': Project.PhaseStatus.COMPLETE}, format='json')
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)

    def _start_phase_3(self):
        self.project.phase_1_status = Project.PhaseStatus.COMPLETE
        self.project.phase_2_status = Project.PhaseStatus.COMPLETE
        self.project.phase_3_status = Project.PhaseStatus.IN_PROGRESS
        self.project.save()

    def _confirm_phase_3_requirements(self):
        self.project.requirements.filter(phase=3).update(
            status=PhaseRequirement.Status.COMPLETED, confirmed_by=self.manager, confirmed_at=timezone.now(),
        )

    def _pending_phase_3_signoff(self):
        return ApprovalRequest.objects.get(
            project=self.project,
            request_type=ApprovalRequest.RequestType.PHASE_3_SIGNOFF,
            status=ApprovalRequest.Status.PENDING,
        )

    def _set_execution_status(self, value):
        # The assigned PM is the one who moves execution status -- doing so
        # as self.manager instead would make the manager both the auto-raised
        # request's requester and (later) its decider, which
        # ApprovalRequestPermission correctly refuses as self-approval.
        self.client.force_authenticate(self.pm)
        url = reverse('project-detail', args=[self.project.id])
        response = self.client.patch(url, {'phase_3_execution_status': value}, format='json')
        self.client.force_authenticate(self.manager)
        return response

    def test_execution_status_completed_moves_phase_3_to_awaiting_approval_not_complete(self):
        self._start_phase_3()
        self._confirm_phase_3_requirements()

        response = self._set_execution_status(Project.ExecutionStatus.COMPLETED)
        self.assertEqual(response.status_code, status.HTTP_200_OK)

        self.project.refresh_from_db()
        self.assertEqual(self.project.phase_3_status, Project.PhaseStatus.AWAITING_APPROVAL)
        self.assertNotEqual(self.project.phase_3_status, Project.PhaseStatus.COMPLETE)
        self.assertTrue(
            ApprovalRequest.objects.filter(
                project=self.project,
                request_type=ApprovalRequest.RequestType.PHASE_3_SIGNOFF,
                status=ApprovalRequest.Status.PENDING,
            ).exists(),
        )

    def test_approving_phase_3_signoff_completes_it_and_starts_phase_4(self):
        self._start_phase_3()
        self._confirm_phase_3_requirements()
        self._set_execution_status(Project.ExecutionStatus.COMPLETED)

        response = self._decide(self._pending_phase_3_signoff(), ApprovalRequest.Status.APPROVED)
        self.assertEqual(response.status_code, status.HTTP_200_OK)

        self.project.refresh_from_db()
        self.assertEqual(self.project.phase_3_status, Project.PhaseStatus.COMPLETE)
        self.assertEqual(self.project.phase_4_status, Project.PhaseStatus.IN_PROGRESS)
        self.assertFalse(self.project.maintenance)

    def test_rejecting_phase_3_signoff_returns_it_to_in_progress_and_review(self):
        self._start_phase_3()
        self._confirm_phase_3_requirements()
        self._set_execution_status(Project.ExecutionStatus.COMPLETED)

        response = self._decide(self._pending_phase_3_signoff(), ApprovalRequest.Status.REJECTED)
        self.assertEqual(response.status_code, status.HTTP_200_OK)

        self.project.refresh_from_db()
        self.assertEqual(self.project.phase_3_status, Project.PhaseStatus.IN_PROGRESS)
        self.assertEqual(self.project.phase_3_execution_status, Project.ExecutionStatus.REVIEW)
        self.assertTrue(
            ExecutionStatusEvent.objects.filter(
                project=self.project,
                from_status=Project.ExecutionStatus.COMPLETED,
                to_status=Project.ExecutionStatus.REVIEW,
            ).exists(),
        )

    def test_execution_status_can_move_backwards_before_phase_3_completes(self):
        self._start_phase_3()
        response = self._set_execution_status(Project.ExecutionStatus.REVIEW)
        self.assertEqual(response.status_code, status.HTTP_200_OK)

        # Review -> Building: backwards, but Phase 3 isn't COMPLETE yet.
        response = self._set_execution_status(Project.ExecutionStatus.BUILDING)
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.project.refresh_from_db()
        self.assertEqual(self.project.phase_3_execution_status, Project.ExecutionStatus.BUILDING)

    def test_execution_status_cannot_change_once_phase_3_is_complete(self):
        self._start_phase_3()
        self._confirm_phase_3_requirements()
        self._set_execution_status(Project.ExecutionStatus.COMPLETED)
        self._decide(self._pending_phase_3_signoff(), ApprovalRequest.Status.APPROVED)

        response = self._set_execution_status(Project.ExecutionStatus.REVIEW)
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.project.refresh_from_db()
        self.assertEqual(self.project.phase_3_execution_status, Project.ExecutionStatus.COMPLETED)

        event = ExecutionStatusEvent.objects.get(project=self.project)
        self.assertIsNone(event.from_status)
        self.assertEqual(event.to_status, Project.ExecutionStatus.COMPLETED)

    def test_approving_phase_4_signoff_completes_phase_4_and_sets_maintenance(self):
        self.project.phase_1_status = Project.PhaseStatus.COMPLETE
        self.project.phase_2_status = Project.PhaseStatus.COMPLETE
        self.project.phase_3_status = Project.PhaseStatus.COMPLETE
        self.project.phase_4_status = Project.PhaseStatus.IN_PROGRESS
        self.project.save()
        approval = self._create_signoff(ApprovalRequest.RequestType.PHASE_4_SIGNOFF)

        exec_manager = User.objects.create_user(
            username='exec_pf', password='pass', role=User.Role.EXECUTIVE_MANAGER,
        )
        self.client.force_authenticate(exec_manager)
        response = self._decide(approval, ApprovalRequest.Status.APPROVED)
        self.assertEqual(response.status_code, status.HTTP_200_OK)

        self.project.refresh_from_db()
        self.assertEqual(self.project.phase_4_status, Project.PhaseStatus.COMPLETE)
        self.assertTrue(self.project.maintenance)

    def test_approving_phase_1_signoff_without_project_manager_is_rejected(self):
        # Phase 2 is PM-owned and can't start unassigned.
        self.project.project_manager = None
        self.project.save(update_fields=['project_manager'])
        approval = self._create_signoff(ApprovalRequest.RequestType.PHASE_1_SIGNOFF)

        response = self._decide(approval, ApprovalRequest.Status.APPROVED)
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)

        approval.refresh_from_db()
        self.project.refresh_from_db()
        self.assertEqual(approval.status, ApprovalRequest.Status.PENDING)
        self.assertEqual(self.project.phase_1_status, Project.PhaseStatus.IN_PROGRESS)

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
        # status is deliberately not exercised here -- see
        # LeadStatusPermissionTests for that rule specifically.
        self.client.force_authenticate(self.rep)
        url = reverse('lead-detail', args=[self.lead.id])
        response = self.client.patch(url, {'name': 'Acme — Renamed deal'}, format='json')
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


class LeadCompanyScopingTests(ArchiveTestMixin, APITestCase):
    def test_rep_can_create_lead_on_owned_company(self):
        self.client.force_authenticate(self.rep)
        response = self.client.post(
            reverse('lead-list'), {'name': 'Acme — New deal', 'company': self.company.id}, format='json',
        )
        self.assertEqual(response.status_code, status.HTTP_201_CREATED)

    def test_rep_can_create_lead_on_company_where_they_have_an_assigned_lead_but_no_ownership(self):
        # self.lead (from ArchiveTestMixin) already assigns self.rep on
        # self.company -- reassign ownership elsewhere so only that
        # assigned-lead relationship remains.
        other_owner = User.objects.create_user(username='owner2', password='pass', role=User.Role.SALES_REP)
        self.company.owner = other_owner
        self.company.save(update_fields=['owner'])

        self.client.force_authenticate(self.rep)
        response = self.client.post(
            reverse('lead-list'), {'name': 'Acme — Second deal', 'company': self.company.id}, format='json',
        )
        self.assertEqual(response.status_code, status.HTTP_201_CREATED)

    def test_rep_cannot_create_lead_on_unrelated_company(self):
        unrelated = Company.objects.create(name='Unrelated Co', owner=self.other_rep)
        self.client.force_authenticate(self.rep)
        response = self.client.post(
            reverse('lead-list'), {'name': 'Unrelated — deal', 'company': unrelated.id}, format='json',
        )
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn('company', response.data)

    def test_rep_cannot_move_a_lead_to_an_unrelated_company(self):
        unrelated = Company.objects.create(name='Unrelated Co', owner=self.other_rep)
        self.client.force_authenticate(self.rep)
        url = reverse('lead-detail', args=[self.lead.id])
        response = self.client.patch(url, {'company': unrelated.id}, format='json')
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn('company', response.data)

    def test_manager_can_create_lead_on_any_company(self):
        unrelated = Company.objects.create(name='Unrelated Co', owner=self.other_rep)
        self.client.force_authenticate(self.manager)
        response = self.client.post(
            reverse('lead-list'),
            {'name': 'Unrelated — deal', 'company': unrelated.id, 'assigned_to': self.rep.id},
            format='json',
        )
        self.assertEqual(response.status_code, status.HTTP_201_CREATED)


class LeadStatusPermissionTests(ArchiveTestMixin, APITestCase):
    def test_rep_cannot_change_status(self):
        self.client.force_authenticate(self.rep)
        url = reverse('lead-detail', args=[self.lead.id])
        response = self.client.patch(url, {'status': Lead.Status.HOT}, format='json')
        self.assertIn(response.status_code, (status.HTTP_400_BAD_REQUEST, status.HTTP_403_FORBIDDEN))
        self.lead.refresh_from_db()
        self.assertEqual(self.lead.status, Lead.Status.COLD)

    def test_manager_can_change_status_with_reason(self):
        self.client.force_authenticate(self.manager)
        url = reverse('lead-detail', args=[self.lead.id])
        response = self.client.patch(url, {
            'status': Lead.Status.HOT,
            'status_change_reason': "Client confirmed budget on today's call.",
        }, format='json')
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.lead.refresh_from_db()
        self.assertEqual(self.lead.status, Lead.Status.HOT)

        event = ActivityEvent.objects.get(lead=self.lead, category=ActivityEvent.Category.ADMINISTRATIVE)
        self.assertIn('HOT', event.description)
        self.assertIn('budget', event.description)

    def test_manager_cannot_change_status_without_reason(self):
        self.client.force_authenticate(self.manager)
        url = reverse('lead-detail', args=[self.lead.id])
        response = self.client.patch(url, {'status': Lead.Status.HOT}, format='json')
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn('status_change_reason', response.data)
        self.lead.refresh_from_db()
        self.assertEqual(self.lead.status, Lead.Status.COLD)


class LeadStatusChangeApprovalFlowTests(ArchiveTestMixin, APITestCase):
    def test_rep_can_request_status_change_with_reason(self):
        self.client.force_authenticate(self.rep)
        response = self.client.post(reverse('approvalrequest-list'), {
            'request_type': ApprovalRequest.RequestType.LEAD_STATUS_CHANGE,
            'lead': self.lead.id,
            'target_status': Lead.Status.HOT,
            'reason': 'Client verbally committed to the renewal.',
        }, format='json')
        self.assertEqual(response.status_code, status.HTTP_201_CREATED)

    def test_request_without_reason_is_rejected(self):
        self.client.force_authenticate(self.rep)
        response = self.client.post(reverse('approvalrequest-list'), {
            'request_type': ApprovalRequest.RequestType.LEAD_STATUS_CHANGE,
            'lead': self.lead.id,
            'target_status': Lead.Status.HOT,
        }, format='json')
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn('reason', response.data)

    def test_request_without_target_status_is_rejected(self):
        self.client.force_authenticate(self.rep)
        response = self.client.post(reverse('approvalrequest-list'), {
            'request_type': ApprovalRequest.RequestType.LEAD_STATUS_CHANGE,
            'lead': self.lead.id,
            'reason': 'Client verbally committed to the renewal.',
        }, format='json')
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn('target_status', response.data)

    def test_approving_applies_status_change_and_logs_event(self):
        self.client.force_authenticate(self.rep)
        create = self.client.post(reverse('approvalrequest-list'), {
            'request_type': ApprovalRequest.RequestType.LEAD_STATUS_CHANGE,
            'lead': self.lead.id,
            'target_status': Lead.Status.HOT,
            'reason': 'Client verbally committed to the renewal.',
        }, format='json')
        self.assertEqual(create.status_code, status.HTTP_201_CREATED)

        self.client.force_authenticate(self.manager)
        url = reverse('approvalrequest-detail', args=[create.data['id']])
        response = self.client.patch(url, {'status': ApprovalRequest.Status.APPROVED}, format='json')
        self.assertEqual(response.status_code, status.HTTP_200_OK)

        self.lead.refresh_from_db()
        self.assertEqual(self.lead.status, Lead.Status.HOT)
        event = ActivityEvent.objects.get(lead=self.lead, category=ActivityEvent.Category.ADMINISTRATIVE)
        self.assertIn('HOT', event.description)
        self.assertIn('renewal', event.description)

    def test_rejecting_does_not_change_status(self):
        self.client.force_authenticate(self.rep)
        create = self.client.post(reverse('approvalrequest-list'), {
            'request_type': ApprovalRequest.RequestType.LEAD_STATUS_CHANGE,
            'lead': self.lead.id,
            'target_status': Lead.Status.HOT,
            'reason': 'Client verbally committed to the renewal.',
        }, format='json')

        self.client.force_authenticate(self.manager)
        url = reverse('approvalrequest-detail', args=[create.data['id']])
        response = self.client.patch(
            url, {'status': ApprovalRequest.Status.REJECTED, 'decision_note': 'Not yet.'}, format='json',
        )
        self.assertEqual(response.status_code, status.HTTP_200_OK)

        self.lead.refresh_from_db()
        self.assertEqual(self.lead.status, Lead.Status.COLD)

    def test_duplicate_pending_status_change_request_rejected(self):
        self.client.force_authenticate(self.rep)
        url = reverse('approvalrequest-list')
        first = self.client.post(url, {
            'request_type': ApprovalRequest.RequestType.LEAD_STATUS_CHANGE,
            'lead': self.lead.id,
            'target_status': Lead.Status.HOT,
            'reason': 'First reason.',
        }, format='json')
        self.assertEqual(first.status_code, status.HTTP_201_CREATED)

        second = self.client.post(url, {
            'request_type': ApprovalRequest.RequestType.LEAD_STATUS_CHANGE,
            'lead': self.lead.id,
            'target_status': Lead.Status.HOT,
            'reason': 'Second reason.',
        }, format='json')
        self.assertEqual(second.status_code, status.HTTP_400_BAD_REQUEST)


class ApprovalRequestRequesterLeadRelationshipTests(APITestCase):
    def setUp(self):
        self.rep = User.objects.create_user(username='rep', password='pass', role=User.Role.SALES_REP)
        self.other_rep = User.objects.create_user(username='rep2', password='pass', role=User.Role.SALES_REP)
        self.manager = User.objects.create_user(username='mgr', password='pass', role=User.Role.SALES_MANAGER)
        self.company = Company.objects.create(name='Acme', owner=self.rep)
        self.other_lead = Lead.objects.create(company=self.company, assigned_to=self.other_rep)
        self.own_lead = Lead.objects.create(company=self.company, assigned_to=self.rep)

    def test_rep_cannot_raise_status_change_for_unassigned_lead(self):
        self.client.force_authenticate(self.rep)
        response = self.client.post(reverse('approvalrequest-list'), {
            'request_type': ApprovalRequest.RequestType.LEAD_STATUS_CHANGE,
            'lead': self.other_lead.id,
            'target_status': Lead.Status.HOT,
            'reason': "Trying to flip someone else's lead.",
        }, format='json')
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn('lead', response.data)

    def test_rep_cannot_raise_archive_for_unassigned_lead(self):
        self.client.force_authenticate(self.rep)
        response = self.client.post(reverse('approvalrequest-list'), {
            'request_type': ApprovalRequest.RequestType.ARCHIVE_LEAD,
            'lead': self.other_lead.id,
            'reason': 'Not mine to archive.',
        }, format='json')
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn('lead', response.data)

    def test_rep_can_raise_request_for_own_assigned_lead(self):
        self.client.force_authenticate(self.rep)
        response = self.client.post(reverse('approvalrequest-list'), {
            'request_type': ApprovalRequest.RequestType.LEAD_STATUS_CHANGE,
            'lead': self.own_lead.id,
            'target_status': Lead.Status.HOT,
            'reason': 'This one is actually mine.',
        }, format='json')
        self.assertEqual(response.status_code, status.HTTP_201_CREATED)

    def test_manager_is_unrestricted_by_the_lead_relationship_check(self):
        self.client.force_authenticate(self.manager)
        response = self.client.post(reverse('approvalrequest-list'), {
            'request_type': ApprovalRequest.RequestType.LEAD_STATUS_CHANGE,
            'lead': self.other_lead.id,
            'target_status': Lead.Status.HOT,
            'reason': 'Manager raising on behalf of the team.',
        }, format='json')
        self.assertEqual(response.status_code, status.HTTP_201_CREATED)


class ApprovalRequestQuerysetScopingTests(APITestCase):
    def setUp(self):
        self.rep = User.objects.create_user(username='rep', password='pass', role=User.Role.SALES_REP)
        self.other_rep = User.objects.create_user(username='rep2', password='pass', role=User.Role.SALES_REP)
        self.manager = User.objects.create_user(username='mgr', password='pass', role=User.Role.SALES_MANAGER)
        self.pm = User.objects.create_user(username='pm', password='pass', role=User.Role.PROJECT_MANAGER)
        self.company = Company.objects.create(name='Acme', owner=self.rep)
        self.lead = Lead.objects.create(company=self.company, assigned_to=self.rep)
        self.other_lead = Lead.objects.create(company=self.company, assigned_to=self.other_rep)
        self.lead.project.project_manager = self.pm
        self.lead.project.save(update_fields=['project_manager'])

        self.own_request = ApprovalRequest.objects.create(
            request_type=ApprovalRequest.RequestType.ARCHIVE_LEAD, lead=self.lead, requested_by=self.rep,
        )
        self.other_request = ApprovalRequest.objects.create(
            request_type=ApprovalRequest.RequestType.ARCHIVE_LEAD, lead=self.other_lead, requested_by=self.other_rep,
        )
        self.managed_project_request = ApprovalRequest.objects.create(
            request_type=ApprovalRequest.RequestType.PHASE_1_SIGNOFF, project=self.lead.project,
            requested_by=self.rep,
        )

    def test_rep_sees_only_their_own_request(self):
        self.client.force_authenticate(self.rep)
        response = self.client.get(reverse('approvalrequest-list'))
        ids = {row['id'] for row in response.data}
        self.assertEqual(ids, {self.own_request.id, self.managed_project_request.id})

    def test_project_manager_sees_own_submissions_and_managed_project_requests(self):
        self.client.force_authenticate(self.pm)
        response = self.client.get(reverse('approvalrequest-list'))
        ids = {row['id'] for row in response.data}
        # Not requested_by the PM, but tied to a project they manage.
        self.assertIn(self.managed_project_request.id, ids)
        self.assertNotIn(self.own_request.id, ids)
        self.assertNotIn(self.other_request.id, ids)

    def test_manager_sees_every_request(self):
        self.client.force_authenticate(self.manager)
        response = self.client.get(reverse('approvalrequest-list'))
        ids = {row['id'] for row in response.data}
        self.assertEqual(ids, {self.own_request.id, self.other_request.id, self.managed_project_request.id})


class PhaseFourSignoffPermissionTests(ProjectRequirementsTestMixin, APITestCase):
    def setUp(self):
        super().setUp()
        self.project.phase_1_status = Project.PhaseStatus.COMPLETE
        self.project.phase_2_status = Project.PhaseStatus.COMPLETE
        self.project.phase_3_status = Project.PhaseStatus.COMPLETE
        self.project.phase_4_status = Project.PhaseStatus.IN_PROGRESS
        self.project.save()
        self.approval = ApprovalRequest.objects.create(
            request_type=ApprovalRequest.RequestType.PHASE_4_SIGNOFF, project=self.project, requested_by=self.rep,
        )
        self.exec_manager = User.objects.create_user(
            username='exec_perm', password='pass', role=User.Role.EXECUTIVE_MANAGER,
        )

    def test_executive_manager_can_decide(self):
        self.client.force_authenticate(self.exec_manager)
        url = reverse('approvalrequest-detail', args=[self.approval.id])
        response = self.client.patch(url, {'status': ApprovalRequest.Status.APPROVED}, format='json')
        self.assertEqual(response.status_code, status.HTTP_200_OK)

    def test_sales_manager_cannot_decide(self):
        self.client.force_authenticate(self.manager)
        url = reverse('approvalrequest-detail', args=[self.approval.id])
        response = self.client.patch(url, {'status': ApprovalRequest.Status.APPROVED}, format='json')
        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)
        self.approval.refresh_from_db()
        self.assertEqual(self.approval.status, ApprovalRequest.Status.PENDING)


class ProjectManagerRoleScopingTests(APITestCase):
    def setUp(self):
        self.pm = User.objects.create_user(username='pm', password='pass', role=User.Role.PROJECT_MANAGER)
        self.other_pm = User.objects.create_user(username='pm2', password='pass', role=User.Role.PROJECT_MANAGER)
        self.rep = User.objects.create_user(username='rep', password='pass', role=User.Role.SALES_REP)
        self.company = Company.objects.create(name='Acme', owner=self.rep)
        self.contact = Contact.objects.create(company=self.company, name='Jane Doe')
        self.lead = Lead.objects.create(company=self.company, contact=self.contact, assigned_to=self.rep)
        self.project = self.lead.project
        self.project.project_manager = self.pm
        self.project.save(update_fields=['project_manager'])

        self.other_lead = Lead.objects.create(company=self.company, assigned_to=self.rep)
        self.other_project = self.other_lead.project

    def test_pm_can_read_and_patch_their_managed_project(self):
        self.client.force_authenticate(self.pm)
        url = reverse('project-detail', args=[self.project.id])
        get_response = self.client.get(url)
        self.assertEqual(get_response.status_code, status.HTTP_200_OK)

        patch_response = self.client.patch(
            url, {'phase_3_execution_status': Project.ExecutionStatus.BUILDING}, format='json',
        )
        self.assertEqual(patch_response.status_code, status.HTTP_200_OK)

    def test_pm_cannot_see_a_project_they_do_not_manage(self):
        self.client.force_authenticate(self.pm)
        response = self.client.get(reverse('project-list'), {'lead': self.other_lead.id})
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(len(response.data), 0)

        detail_response = self.client.get(reverse('project-detail', args=[self.other_project.id]))
        self.assertEqual(detail_response.status_code, status.HTTP_404_NOT_FOUND)

    def test_other_pm_cannot_patch_a_project_they_do_not_manage(self):
        self.client.force_authenticate(self.other_pm)
        response = self.client.get(reverse('project-list'), {'lead': self.lead.id})
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(len(response.data), 0)

    def test_pm_can_patch_a_task_on_their_managed_project(self):
        self.client.force_authenticate(self.pm)
        requirement = self.project.requirements.filter(phase=2).first()
        url = reverse('phaserequirement-detail', args=[requirement.id])
        response = self.client.patch(url, {'status': 'IN_PROGRESS'}, format='json')
        self.assertEqual(response.status_code, status.HTTP_200_OK)

    def test_pm_is_read_only_on_lead(self):
        self.client.force_authenticate(self.pm)
        url = reverse('lead-detail', args=[self.lead.id])
        get_response = self.client.get(url)
        self.assertEqual(get_response.status_code, status.HTTP_200_OK)

        patch_response = self.client.patch(url, {'name': 'Renamed'}, format='json')
        self.assertEqual(patch_response.status_code, status.HTTP_403_FORBIDDEN)

    def test_pm_is_read_only_on_company(self):
        self.client.force_authenticate(self.pm)
        url = reverse('company-detail', args=[self.company.id])
        response = self.client.patch(url, {'industry': 'Retail'}, format='json')
        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)

    def test_pm_is_read_only_on_contact(self):
        self.client.force_authenticate(self.pm)
        url = reverse('contact-detail', args=[self.contact.id])
        response = self.client.patch(url, {'job_title': 'CTO'}, format='json')
        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)


class ProjectAndPhaseRequirementRepScopingTests(APITestCase):
    def setUp(self):
        self.owner_rep = User.objects.create_user(username='ownerrep', password='pass', role=User.Role.SALES_REP)
        self.assigned_rep = User.objects.create_user(
            username='assignedrep', password='pass', role=User.Role.SALES_REP,
        )
        self.company = Company.objects.create(name='Acme', owner=self.owner_rep)
        self.lead = Lead.objects.create(company=self.company, name='Acme — Deal', assigned_to=self.assigned_rep)
        self.project = self.lead.project

    def test_assigned_rep_can_list_and_retrieve_project(self):
        self.client.force_authenticate(self.assigned_rep)
        list_response = self.client.get(reverse('project-list'), {'lead': self.lead.id})
        self.assertEqual(list_response.status_code, status.HTTP_200_OK)
        self.assertEqual(len(list_response.data), 1)

        detail_response = self.client.get(reverse('project-detail', args=[self.project.id]))
        self.assertEqual(detail_response.status_code, status.HTTP_200_OK)

    def test_assigned_rep_can_read_and_update_tasks(self):
        self.client.force_authenticate(self.assigned_rep)
        requirement = self.project.requirements.first()

        list_response = self.client.get(reverse('phaserequirement-list'), {'project': self.project.id})
        self.assertEqual(list_response.status_code, status.HTTP_200_OK)
        self.assertTrue(len(list_response.data) > 0)

        url = reverse('phaserequirement-detail', args=[requirement.id])
        patch_response = self.client.patch(url, {'status': 'IN_PROGRESS'}, format='json')
        self.assertEqual(patch_response.status_code, status.HTTP_200_OK)

    def test_unrelated_rep_cannot_see_project_or_tasks(self):
        unrelated_rep = User.objects.create_user(username='unrelated', password='pass', role=User.Role.SALES_REP)
        self.client.force_authenticate(unrelated_rep)

        project_response = self.client.get(reverse('project-list'), {'lead': self.lead.id})
        self.assertEqual(project_response.status_code, status.HTTP_200_OK)
        self.assertEqual(len(project_response.data), 0)

        requirement_response = self.client.get(reverse('phaserequirement-list'), {'project': self.project.id})
        self.assertEqual(requirement_response.status_code, status.HTTP_200_OK)
        self.assertEqual(len(requirement_response.data), 0)


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
        # Phase 1 -- only the assigned rep may complete it.
        self.client.force_authenticate(self.rep)
        url = reverse('phaserequirement-detail', args=[self.requirement.id])
        response = self.client.patch(url, {'status': PhaseRequirement.Status.COMPLETED}, format='json')
        self.assertEqual(response.status_code, status.HTTP_200_OK)

        event = ActivityEvent.objects.get(lead=self.lead, category=ActivityEvent.Category.PHASE)
        self.assertIn(self.requirement.label, event.description)
        self.assertEqual(event.actor, self.rep)

    # Whether completing a task flips a COLD lead to HOT is now conditional
    # on client_facing (see ClientFacingTaskActivityTests below) -- this
    # class only covers the ActivityEvent/timeline side of task completion.

    def test_task_activity_event_appears_in_the_timeline(self):
        self.client.force_authenticate(self.rep)
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

    def test_client_facing_task_completing_updates_last_activity_but_not_status(self):
        requirement = self.project.requirements.get(label='Client Proposal Confirmation')
        self.assertTrue(requirement.client_facing)

        # Phase 1 -- only the assigned rep may complete it.
        self.client.force_authenticate(self.rep)
        url = reverse('phaserequirement-detail', args=[requirement.id])
        response = self.client.patch(url, {'status': PhaseRequirement.Status.COMPLETED}, format='json')
        self.assertEqual(response.status_code, status.HTTP_200_OK)

        self.lead.refresh_from_db()
        self.assertEqual(self.lead.status, Lead.Status.COLD)
        self.assertGreater(self.lead.last_activity_at, self.original_last_activity_at)
        # Mutually exclusive with the internal-activity field -- a
        # client-facing completion still only ever touches last_activity_at,
        # never last_internal_activity_at.
        self.assertIsNone(self.lead.last_internal_activity_at)

    def test_internal_task_completing_does_not_flip_cold_lead_to_hot(self):
        requirement = self.project.requirements.get(label='Technical Specification')
        self.assertFalse(requirement.client_facing)

        # Phase 3 -- only the assigned PM may complete it.
        self.client.force_authenticate(self.pm)
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


class ReportsApiTests(ProjectRequirementsTestMixin, APITestCase):
    """
    /api/reports/ -- management-only aggregation. The mixin gives us a
    company, a rep, a PM and one project with its full requirement set.
    """

    def _get(self, **params):
        return self.client.get(reverse('reports'), params)

    def test_a_rep_cannot_read_the_report(self):
        self.client.force_authenticate(self.rep)
        self.assertEqual(self._get().status_code, status.HTTP_403_FORBIDDEN)

    def test_a_project_manager_cannot_read_the_report(self):
        self.client.force_authenticate(self.pm)
        self.assertEqual(self._get().status_code, status.HTTP_403_FORBIDDEN)

    def test_management_can_read_the_report(self):
        response = self._get()
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        for key in (
            'projects_per_phase', 'average_days_per_phase', 'per_rep', 'per_project_manager',
            'approval_throughput', 'phase_3_budget', 'interaction_volume',
        ):
            self.assertIn(key, response.data)

    def test_the_range_defaults_to_the_last_30_days(self):
        response = self._get()
        today = timezone.localdate()
        self.assertEqual(response.data['range']['end'], today.isoformat())
        self.assertEqual(response.data['range']['start'], (today - timedelta(days=29)).isoformat())

    def test_a_malformed_date_is_rejected(self):
        response = self._get(start='last-tuesday')
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)

    def test_a_backwards_range_is_rejected(self):
        today = timezone.localdate()
        response = self._get(start=today.isoformat(), end=(today - timedelta(days=5)).isoformat())
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)

    def test_projects_per_phase_counts_the_window_cohort(self):
        response = self._get()
        per_phase = response.data['projects_per_phase']
        self.assertEqual(per_phase['total'], 1)
        self.assertEqual(per_phase['phases'][0], {'phase': 1, 'count': 1})
        self.assertEqual(per_phase['maintenance'], 0)

        # A project created before the window isn't in its cohort.
        response = self._get(
            start=(timezone.localdate() - timedelta(days=90)).isoformat(),
            end=(timezone.localdate() - timedelta(days=60)).isoformat(),
        )
        self.assertEqual(response.data['projects_per_phase']['total'], 0)

    def test_per_rep_counts_completed_tasks_and_overdue_separately(self):
        requirement = self.project.requirements.filter(phase=1).first()
        requirement.status = PhaseRequirement.Status.COMPLETED
        requirement.completed_at = timezone.now()
        requirement.save(update_fields=['status', 'completed_at'])

        overdue = self.project.requirements.filter(phase=1).exclude(pk=requirement.pk).first()
        overdue.due_date = timezone.localdate() - timedelta(days=3)
        overdue.save(update_fields=['due_date'])

        row = next(r for r in self._get().data['per_rep'] if r['username'] == self.rep.username)
        self.assertEqual(row['tasks_completed'], 1)
        self.assertEqual(row['tasks_overdue'], 1)
        self.assertIsNotNone(row['average_days_to_complete_task'])

    def test_per_rep_ignores_a_task_completed_outside_the_window(self):
        requirement = self.project.requirements.filter(phase=1).first()
        requirement.status = PhaseRequirement.Status.COMPLETED
        requirement.completed_at = timezone.now() - timedelta(days=200)
        requirement.save(update_fields=['status', 'completed_at'])

        row = next(r for r in self._get().data['per_rep'] if r['username'] == self.rep.username)
        self.assertEqual(row['tasks_completed'], 0)

    def test_per_rep_splits_phase_1_signoffs_by_decision(self):
        ApprovalRequest.objects.create(
            request_type=ApprovalRequest.RequestType.PHASE_1_SIGNOFF,
            project=self.project,
            requested_by=self.rep,
            status=ApprovalRequest.Status.APPROVED,
            decided_by=self.manager,
            decided_at=timezone.now(),
        )
        row = next(r for r in self._get().data['per_rep'] if r['username'] == self.rep.username)
        self.assertEqual(row['phase_1_signoffs_approved'], 1)
        self.assertEqual(row['phase_1_signoffs_rejected'], 0)

    def test_per_project_manager_counts_phase_2_and_3_tasks(self):
        for phase in (2, 3):
            requirement = self.project.requirements.filter(phase=phase).first()
            requirement.status = PhaseRequirement.Status.COMPLETED
            requirement.completed_at = timezone.now()
            requirement.save(update_fields=['status', 'completed_at'])

        row = next(r for r in self._get().data['per_project_manager'] if r['username'] == self.pm.username)
        self.assertEqual(row['phase_2_tasks_completed'], 1)
        self.assertEqual(row['phase_3_tasks_completed'], 1)
        self.assertEqual(row['projects_managed'], 1)

    def test_approval_throughput_reports_raised_and_decided_counts(self):
        ApprovalRequest.objects.create(
            request_type=ApprovalRequest.RequestType.PHASE_1_SIGNOFF,
            project=self.project,
            requested_by=self.rep,
            status=ApprovalRequest.Status.APPROVED,
            decided_by=self.manager,
            decided_at=timezone.now(),
        )
        throughput = self._get().data['approval_throughput']
        self.assertEqual(throughput['raised'], 1)
        self.assertEqual(throughput['approved'], 1)
        self.assertEqual(throughput['rejected'], 0)
        self.assertIsNotNone(throughput['average_days_to_decision'])

    def test_phase_3_budget_only_counts_projects_that_got_that_far(self):
        self.project.proposed_budget = Decimal('1000.00')
        self.project.save(update_fields=['proposed_budget'])

        # Still in Phase 1 -- it hasn't reached execution.
        self.assertEqual(self._get().data['phase_3_budget']['projects'], 0)

        self.project.current_phase = 3
        self.project.save(update_fields=['current_phase'])
        budget = self._get().data['phase_3_budget']
        self.assertEqual(budget['projects'], 1)
        self.assertEqual(budget['total_proposed_budget'], '1000.00')
        self.assertEqual(budget['average_proposed_budget'], '1000.00')

    def test_interaction_volume_groups_by_outcome(self):
        Interaction.objects.create(
            lead=self.lead, type=Interaction.Type.CALL,
            outcome=Interaction.Outcome.NO_ANSWER, created_by=self.rep,
        )
        Interaction.objects.create(
            lead=self.lead, type=Interaction.Type.CALL,
            outcome=Interaction.Outcome.NO_ANSWER, created_by=self.rep,
        )
        volume = {row['outcome']: row['count'] for row in self._get().data['interaction_volume']}
        self.assertEqual(volume[Interaction.Outcome.NO_ANSWER], 2)


class LeadAssignmentRoleTests(ArchiveTestMixin, APITestCase):
    """
    A lead is carried by a sales rep, never by a manager -- enforced in
    LeadSerializer so it holds for a direct API call, not just the pickers
    (which only ever list ?role=SALES_REP).
    """

    def test_a_lead_cannot_be_assigned_to_a_manager(self):
        self.client.force_authenticate(self.manager)
        response = self.client.post(
            reverse('lead-list'),
            {'name': 'Acme — Renewal', 'company': self.company.id, 'assigned_to': self.manager.id},
            format='json',
        )
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn('sales rep', str(response.data['assigned_to']))

    def test_a_lead_cannot_be_reassigned_to_a_manager(self):
        self.client.force_authenticate(self.manager)
        response = self.client.patch(
            reverse('lead-detail', args=[self.lead.id]),
            {'assigned_to': self.manager.id},
            format='json',
        )
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.lead.refresh_from_db()
        self.assertEqual(self.lead.assigned_to, self.rep)

    def test_a_lead_cannot_be_assigned_to_a_project_manager_either(self):
        pm = User.objects.create_user(username='pm-assign', password='pass', role=User.Role.PROJECT_MANAGER)
        self.client.force_authenticate(self.manager)
        response = self.client.patch(
            reverse('lead-detail', args=[self.lead.id]), {'assigned_to': pm.id}, format='json',
        )
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)

    def test_a_manager_must_name_the_rep_when_creating_a_lead(self):
        # This used to fall back to the creator, which can no longer be right.
        self.client.force_authenticate(self.manager)
        response = self.client.post(
            reverse('lead-list'), {'name': 'Acme — Unassigned', 'company': self.company.id}, format='json',
        )
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn('assigned_to', response.data)

    def test_a_lead_can_still_be_assigned_to_a_rep(self):
        self.client.force_authenticate(self.manager)
        response = self.client.patch(
            reverse('lead-detail', args=[self.lead.id]), {'assigned_to': self.other_rep.id}, format='json',
        )
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.lead.refresh_from_db()
        self.assertEqual(self.lead.assigned_to, self.other_rep)

    def test_a_rep_creating_their_own_lead_is_still_self_assigned(self):
        self.client.force_authenticate(self.rep)
        response = self.client.post(
            reverse('lead-list'), {'name': 'Acme — Rep raised', 'company': self.company.id}, format='json',
        )
        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        self.assertEqual(response.data['assigned_to'], self.rep.id)

    def test_the_serializer_reports_the_assignees_role(self):
        self.client.force_authenticate(self.manager)
        response = self.client.get(reverse('lead-detail', args=[self.lead.id]))
        self.assertEqual(response.data['assigned_to_role'], User.Role.SALES_REP)


class SystemAdminReadAccessTests(ArchiveTestMixin, APITestCase):
    """
    SYSTEM_ADMIN reads everything -- every rep's pipeline, every project,
    the dashboard, the board's project list, the calendar and the report --
    while every existing write restriction stays exactly as it was.
    """

    def setUp(self):
        super().setUp()
        # A second rep's lead, so "sees everything" means more than "sees
        # the one lead this fixture happens to own".
        self.other_company = Company.objects.create(name='Elsewhere', owner=self.other_rep)
        self.other_lead = Lead.objects.create(company=self.other_company, assigned_to=self.other_rep)
        self.client.force_authenticate(self.admin)

    def test_admin_sees_every_rep_lead(self):
        response = self.client.get(reverse('lead-list'))
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        ids = {row['id'] for row in response.data}
        self.assertIn(self.lead.id, ids)
        self.assertIn(self.other_lead.id, ids)

    def test_admin_sees_every_company_contact_and_project(self):
        for url, expected_id in (
            (reverse('company-list'), self.other_company.id),
            (reverse('contact-list'), self.contact.id),
            (reverse('project-list'), self.other_lead.project.id),
        ):
            response = self.client.get(url)
            self.assertEqual(response.status_code, status.HTTP_200_OK, url)
            self.assertIn(expected_id, {row['id'] for row in response.data}, url)

    def test_admin_sees_every_task_and_interaction(self):
        Interaction.objects.create(
            lead=self.other_lead, type=Interaction.Type.CALL,
            outcome=Interaction.Outcome.RESPONDED, created_by=self.other_rep,
        )
        requirements = self.client.get(reverse('phaserequirement-list'), {'project': self.other_lead.project.id})
        self.assertEqual(requirements.status_code, status.HTTP_200_OK)
        self.assertGreater(len(requirements.data), 0)

        interactions = self.client.get(reverse('interaction-list'))
        self.assertEqual(interactions.status_code, status.HTTP_200_OK)
        self.assertEqual(len(interactions.data), 1)

    def test_admin_sees_every_approval_request(self):
        raised = ApprovalRequest.objects.create(
            request_type=ApprovalRequest.RequestType.PHASE_1_SIGNOFF,
            project=self.other_lead.project,
            requested_by=self.other_rep,
        )
        response = self.client.get(reverse('approvalrequest-list'))
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertIn(raised.id, {row['id'] for row in response.data})

    def test_admin_dashboard_calendar_and_report_are_unscoped(self):
        dashboard = self.client.get(reverse('dashboard'))
        self.assertEqual(dashboard.status_code, status.HTTP_200_OK)
        # Both reps' leads counted, not just one's.
        self.assertEqual(dashboard.data['cold_leads']['count'], 2)
        self.assertEqual(dashboard.data['active_projects']['count'], 2)

        self.assertEqual(self.client.get(reverse('calendar')).status_code, status.HTTP_200_OK)
        self.assertEqual(self.client.get(reverse('reports')).status_code, status.HTTP_200_OK)

    def test_admin_can_read_a_lead_detail_it_does_not_own(self):
        response = self.client.get(reverse('lead-detail', args=[self.other_lead.id]))
        self.assertEqual(response.status_code, status.HTTP_200_OK)

    def test_admin_write_restrictions_are_unchanged(self):
        # Still read-only on records: no creating, no editing, no completing.
        create = self.client.post(
            reverse('lead-list'),
            {'name': 'Admin raised', 'company': self.company.id, 'assigned_to': self.rep.id},
            format='json',
        )
        self.assertEqual(create.status_code, status.HTTP_403_FORBIDDEN)

        update = self.client.patch(
            reverse('lead-detail', args=[self.lead.id]), {'name': 'Renamed'}, format='json',
        )
        self.assertEqual(update.status_code, status.HTTP_403_FORBIDDEN)

        task = self.project.requirements.filter(phase=1).first()
        complete = self.client.patch(
            reverse('phaserequirement-detail', args=[task.id]),
            {'status': PhaseRequirement.Status.COMPLETED},
            format='json',
        )
        self.assertEqual(complete.status_code, status.HTTP_400_BAD_REQUEST)
        task.refresh_from_db()
        self.assertEqual(task.status, PhaseRequirement.Status.PENDING)

    def test_admin_can_still_hard_delete_an_archived_record(self):
        self.company.is_archived = True
        self.company.save(update_fields=['is_archived'])
        response = self.client.delete(reverse('company-detail', args=[self.company.id]))
        self.assertEqual(response.status_code, status.HTTP_204_NO_CONTENT)


class ManagerHeldLeadMigrationTests(TestCase):
    """
    Migration 0028 moves leads that a manager was holding onto a rep. The
    rule is exercised here against the real models (the historical ones the
    migration receives are the same shape), so the choice of rep -- company
    owner first, otherwise the least-loaded rep -- is covered rather than
    just "it ran".
    """

    def setUp(self):
        self.migration = importlib.import_module('crm.migrations.0028_reassign_manager_held_leads')
        self.manager = User.objects.create_user(username='mgr-mig', password='pass', role=User.Role.SALES_MANAGER)
        self.owner_rep = User.objects.create_user(username='rep-owner', password='pass', role=User.Role.SALES_REP)
        self.spare_rep = User.objects.create_user(username='rep-spare', password='pass', role=User.Role.SALES_REP)

    def _run(self):
        models = {'Lead': Lead, 'User': User}

        class FakeApps:
            @staticmethod
            def get_model(app_label, model_name):
                return models[model_name]

        self.migration.reassign_manager_held_leads(FakeApps, None)

    def test_a_manager_held_lead_goes_to_the_company_owner_when_they_are_a_rep(self):
        company = Company.objects.create(name='Owned', owner=self.owner_rep)
        lead = Lead.objects.create(company=company, assigned_to=self.manager)

        self._run()

        lead.refresh_from_db()
        self.assertEqual(lead.assigned_to, self.owner_rep)

    def test_it_falls_back_to_the_least_loaded_rep_when_the_owner_is_not_one(self):
        # owner_rep already carries two leads; spare_rep carries none, so the
        # manager-held lead on a manager-owned company lands with spare_rep.
        busy_company = Company.objects.create(name='Busy', owner=self.owner_rep)
        Lead.objects.create(company=busy_company, assigned_to=self.owner_rep)
        Lead.objects.create(company=busy_company, assigned_to=self.owner_rep)

        manager_owned = Company.objects.create(name='Manager owned', owner=self.manager)
        lead = Lead.objects.create(company=manager_owned, assigned_to=self.manager)

        self._run()

        lead.refresh_from_db()
        self.assertEqual(lead.assigned_to, self.spare_rep)

    def test_reps_leads_are_left_alone(self):
        company = Company.objects.create(name='Untouched', owner=self.owner_rep)
        lead = Lead.objects.create(company=company, assigned_to=self.spare_rep)

        self._run()

        lead.refresh_from_db()
        self.assertEqual(lead.assigned_to, self.spare_rep)

    def test_it_spreads_several_stranded_leads_rather_than_piling_them_up(self):
        manager_owned = Company.objects.create(name='Manager owned', owner=self.manager)
        leads = [Lead.objects.create(company=manager_owned, assigned_to=self.manager) for _ in range(4)]

        self._run()

        assignees = []
        for lead in leads:
            lead.refresh_from_db()
            assignees.append(lead.assigned_to)
        self.assertEqual({user.role for user in assignees}, {User.Role.SALES_REP})
        self.assertEqual(assignees.count(self.owner_rep), 2)
        self.assertEqual(assignees.count(self.spare_rep), 2)

    def test_it_leaves_leads_alone_when_there_is_no_rep_to_move_them_to(self):
        User.objects.filter(role=User.Role.SALES_REP).delete()
        company = Company.objects.create(name='No reps', owner=self.manager)
        lead = Lead.objects.create(company=company, assigned_to=self.manager)

        self._run()

        lead.refresh_from_db()
        self.assertEqual(lead.assigned_to, self.manager)


class LoginRememberMeTests(APITestCase):
    """
    The login form's "Remember me" decides whether the session outlives the
    browser. Left out entirely it stays on, which is what this endpoint did
    before the checkbox existed.
    """

    def setUp(self):
        self.user = User.objects.create_user(
            username='remember-me', password='pass-phrase', role=User.Role.SALES_REP,
        )
        self.url = reverse('auth-login')

    def _login(self, **extra):
        return self.client.post(
            self.url, {'username': 'remember-me', 'password': 'pass-phrase', **extra}, format='json',
        )

    def test_login_without_the_flag_keeps_a_persistent_session(self):
        response = self._login()
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertNotEqual(self.client.session.get_expiry_age(), 0)
        self.assertFalse(self.client.session.get_expire_at_browser_close())

    def test_remember_true_keeps_a_persistent_session(self):
        response = self._login(remember=True)
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertFalse(self.client.session.get_expire_at_browser_close())

    def test_remember_false_expires_the_session_at_browser_close(self):
        response = self._login(remember=False)
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertTrue(self.client.session.get_expire_at_browser_close())

    def test_the_flag_does_not_affect_a_failed_login(self):
        response = self.client.post(
            self.url,
            {'username': 'remember-me', 'password': 'wrong', 'remember': False},
            format='json',
        )
        self.assertEqual(response.status_code, status.HTTP_401_UNAUTHORIZED)
        self.assertNotIn('_auth_user_id', self.client.session)


class TemplateDeduplicationMigrationTests(TestCase):
    """
    Migration 0029 clears the duplicate templates the phase renumbering left
    behind. Exercised against the real models, the same way the lead
    reassignment migration is.
    """

    def setUp(self):
        self.migration = importlib.import_module('crm.migrations.0029_deduplicate_requirement_templates')
        # The migrations that ship the canonical set have already run for
        # this test database, so start from a clean slate.
        RequirementTemplate.objects.all().delete()

    def _run(self):
        models = {
            'RequirementTemplate': RequirementTemplate,
            'PhaseRequirement': PhaseRequirement,
            'TaskFormField': TaskFormField,
        }

        class FakeApps:
            @staticmethod
            def get_model(app_label, model_name):
                return models[model_name]

        self.migration.deduplicate_templates(FakeApps, None)

    def test_an_inactive_twin_is_removed_and_the_active_row_kept(self):
        active = RequirementTemplate.objects.create(phase=2, label='Budget Proposal', is_active=True)
        RequirementTemplate.objects.create(phase=1, label='Budget Proposal', is_active=False)

        self._run()

        self.assertEqual(list(RequirementTemplate.objects.values_list('id', flat=True)), [active.id])

    def test_a_retired_template_with_no_active_twin_survives(self):
        retired = RequirementTemplate.objects.create(phase=1, label='Retired Step', is_active=False)

        self._run()

        self.assertTrue(RequirementTemplate.objects.filter(pk=retired.pk).exists())

    def test_two_active_templates_are_both_kept(self):
        first = RequirementTemplate.objects.create(phase=1, label='Kickoff', is_active=True)
        second = RequirementTemplate.objects.create(phase=3, label='Kickoff', is_active=True)

        self._run()

        self.assertEqual(RequirementTemplate.objects.filter(label='Kickoff').count(), 2)
        self.assertTrue(RequirementTemplate.objects.filter(pk=first.pk).exists())
        self.assertTrue(RequirementTemplate.objects.filter(pk=second.pk).exists())

    def test_tasks_are_repointed_rather_than_orphaned(self):
        active = RequirementTemplate.objects.create(phase=2, label='Budget Proposal', is_active=True)
        stale = RequirementTemplate.objects.create(phase=1, label='Budget Proposal', is_active=False)

        user = User.objects.create_user(username='dedupe-rep', password='pass', role=User.Role.SALES_REP)
        company = Company.objects.create(name='Dedupe Co', owner=user)
        lead = Lead.objects.create(company=company, assigned_to=user)
        task = PhaseRequirement.objects.create(
            project=lead.project, template=stale, phase=1, label='Budget Proposal',
        )

        self._run()

        task.refresh_from_db()
        self.assertEqual(task.template, active)

    def test_a_form_on_the_discarded_row_moves_to_the_kept_one(self):
        active = RequirementTemplate.objects.create(phase=2, label='Budget Proposal', is_active=True)
        stale = RequirementTemplate.objects.create(phase=1, label='Budget Proposal', is_active=False)
        TaskFormField.objects.create(template=stale, label='Proposed budget', field_type='NUMBER')

        self._run()

        self.assertEqual(active.form_fields.count(), 1)
        self.assertEqual(active.form_fields.first().label, 'Proposed budget')

    def test_the_kept_rows_own_form_wins(self):
        active = RequirementTemplate.objects.create(phase=2, label='Budget Proposal', is_active=True)
        TaskFormField.objects.create(template=active, label='Kept field', field_type='TEXT')
        stale = RequirementTemplate.objects.create(phase=1, label='Budget Proposal', is_active=False)
        TaskFormField.objects.create(template=stale, label='Discarded field', field_type='TEXT')

        self._run()

        self.assertEqual([f.label for f in active.form_fields.all()], ['Kept field'])


class RequirementTemplateCopyTests(APITestCase):
    """
    Copying a template into another phase -- what dragging one out of the
    settings library does.
    """

    def setUp(self):
        self.manager = User.objects.create_user(
            username='tmpl-mgr', password='pass', role=User.Role.SALES_MANAGER,
        )
        self.rep = User.objects.create_user(username='tmpl-rep', password='pass', role=User.Role.SALES_REP)
        RequirementTemplate.objects.all().delete()
        self.template = RequirementTemplate.objects.create(
            phase=1, label='Kickoff Call', description='Say hello.', is_active=True,
            confirmation_authority='REP', client_facing=True, default_duration_days=4,
        )
        TaskFormField.objects.create(
            template=self.template, label='Attendees', field_type='TEXT', required=True, order=0,
        )
        self.client.force_authenticate(self.manager)

    def _copy(self, **data):
        return self.client.post(reverse('requirementtemplate-copy', args=[self.template.id]), data, format='json')

    def test_copying_puts_an_active_template_in_the_target_phase(self):
        response = self._copy(phase=3)
        self.assertEqual(response.status_code, status.HTTP_201_CREATED)

        copy = RequirementTemplate.objects.get(pk=response.data['id'])
        self.assertEqual(copy.phase, 3)
        self.assertEqual(copy.label, 'Kickoff Call')
        self.assertTrue(copy.is_active)
        # The original is untouched -- this is a copy, not a move.
        self.template.refresh_from_db()
        self.assertEqual(self.template.phase, 1)

    def test_the_form_travels_with_the_template(self):
        response = self._copy(phase=3)
        copy = RequirementTemplate.objects.get(pk=response.data['id'])

        self.assertEqual([f.label for f in copy.form_fields.all()], ['Attendees'])
        self.assertTrue(copy.form_fields.first().required)
        # Copied, not shared: editing one must not touch the other.
        self.assertNotEqual(copy.form_fields.first().id, self.template.form_fields.first().id)

    def test_the_copy_keeps_authority_and_duration(self):
        response = self._copy(phase=2)
        copy = RequirementTemplate.objects.get(pk=response.data['id'])
        self.assertEqual(copy.confirmation_authority, 'REP')
        self.assertTrue(copy.client_facing)
        self.assertEqual(copy.default_duration_days, 4)

    def test_copying_into_a_phase_that_already_has_it_is_refused(self):
        self._copy(phase=3)
        response = self._copy(phase=3)
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(RequirementTemplate.objects.filter(phase=3, label='Kickoff Call').count(), 1)

    def test_a_bad_phase_is_refused(self):
        self.assertEqual(self._copy(phase=9).status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(self._copy().status_code, status.HTTP_400_BAD_REQUEST)

    def test_a_rep_cannot_copy_a_template(self):
        self.client.force_authenticate(self.rep)
        self.assertEqual(self._copy(phase=2).status_code, status.HTTP_403_FORBIDDEN)

    def test_activating_a_template_into_a_phase_is_a_patch(self):
        retired = RequirementTemplate.objects.create(phase=2, label='Old Step', is_active=False)
        response = self.client.patch(
            reverse('requirementtemplate-detail', args=[retired.id]),
            {'is_active': True, 'phase': 4},
            format='json',
        )
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        retired.refresh_from_db()
        self.assertTrue(retired.is_active)
        self.assertEqual(retired.phase, 4)
