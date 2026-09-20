"""
Management reporting: one read-only endpoint behind /api/reports/.

Kept out of views.py deliberately -- this is the only place in the app that
aggregates *across* people rather than scoping to one, and the aggregation
logic is long enough to drown the CRUD views it would otherwise sit among.

A note on what the date range means, since it can't mean the same thing for
every figure here. Two kinds of number are reported:

  * Activity -- something that happened, with a timestamp: a task completed,
    an approval decided, an interaction logged, a phase finished. These are
    filtered to the range.
  * Inventory -- how things stand right now: which phase each project is in,
    how many tasks are overdue, who manages what. A range can't filter a
    snapshot, so these are scoped by *cohort* instead where that's
    meaningful (projects created in the range) and left current where it
    isn't (overdue tasks, which are only ever overdue as of today).

Each metric below says which of the two it is, and the frontend labels them
the same way -- a reader should never have to guess whether a number covers
the window or the present.
"""

from datetime import datetime, time, timedelta

from django.db.models import Count, Q, Sum
from django.utils import timezone
from rest_framework import status
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from .models import (
    ApprovalRequest,
    Interaction,
    Lead,
    PhaseRequirement,
    Project,
    User,
)
from .permissions import ReportingPermission

DEFAULT_RANGE_DAYS = 30
PHASES = (1, 2, 3, 4)

# Which phases each role is answerable for -- the same split
# PhaseRequirementSerializer enforces on completion (phases 1 and 4 belong to
# the assigned rep, 2 and 3 to the assigned PM), so "tasks completed" here
# counts the work that person was actually responsible for rather than
# whoever happened to touch the row last.
REP_PHASES = (1, 4)
PM_PHASES = (2, 3)

PHASE_SIGNOFF_TYPES = {
    1: ApprovalRequest.RequestType.PHASE_1_SIGNOFF,
    2: ApprovalRequest.RequestType.PHASE_2_SIGNOFF,
    3: ApprovalRequest.RequestType.PHASE_3_SIGNOFF,
    4: ApprovalRequest.RequestType.PHASE_4_SIGNOFF,
}


def _parse_date(value, fallback):
    if not value:
        return fallback
    try:
        return datetime.strptime(value, '%Y-%m-%d').date()
    except (TypeError, ValueError):
        return None


def _as_range(start_date, end_date):
    """
    Dates in, timezone-aware datetimes out, with the end date included in
    full -- a range of 1st to 1st should cover that whole day, not stop at
    midnight before it began.
    """
    tz = timezone.get_current_timezone()
    start = timezone.make_aware(datetime.combine(start_date, time.min), tz)
    end = timezone.make_aware(datetime.combine(end_date, time.max), tz)
    return start, end


def _mean(values, digits=1):
    values = [v for v in values if v is not None]
    if not values:
        return None
    return round(sum(values) / len(values), digits)


def _days_between(start, end):
    if start is None or end is None:
        return None
    return (end - start).total_seconds() / 86400


class ReportsView(APIView):
    """
    GET /api/reports/?start=YYYY-MM-DD&end=YYYY-MM-DD

    Both default to the last 30 days (inclusive of today). Management only --
    see ReportingPermission.
    """

    permission_classes = [IsAuthenticated, ReportingPermission]

    def get(self, request):
        today = timezone.localdate()
        end_date = _parse_date(request.query_params.get('end'), today)
        start_date = _parse_date(
            request.query_params.get('start'), today - timedelta(days=DEFAULT_RANGE_DAYS - 1),
        )
        if start_date is None or end_date is None:
            return Response(
                {'detail': 'start and end must be YYYY-MM-DD dates.'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if start_date > end_date:
            return Response(
                {'detail': 'start must not be after end.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        start, end = _as_range(start_date, end_date)

        # The cohort every project-shaped figure below is drawn from:
        # non-archived projects created inside the window.
        cohort = Project.objects.filter(is_archived=False, created_at__range=(start, end))

        return Response({
            'range': {'start': start_date.isoformat(), 'end': end_date.isoformat()},
            'projects_per_phase': self._projects_per_phase(cohort),
            'average_days_per_phase': self._average_days_per_phase(start, end),
            'per_rep': self._per_rep(start, end),
            'per_project_manager': self._per_project_manager(cohort, start, end),
            'approval_throughput': self._approval_throughput(start, end),
            'phase_3_budget': self._phase_3_budget(cohort),
            'interaction_volume': self._interaction_volume(start, end),
        })

    # -- projects ---------------------------------------------------------

    def _projects_per_phase(self, cohort):
        """Inventory (cohort): where the window's projects stand today."""
        counts = {phase: 0 for phase in PHASES}
        maintenance = 0
        for project in cohort.only('current_phase', 'maintenance'):
            if project.maintenance:
                maintenance += 1
            else:
                counts[project.current_phase] = counts.get(project.current_phase, 0) + 1
        return {
            'phases': [{'phase': phase, 'count': counts.get(phase, 0)} for phase in PHASES],
            'maintenance': maintenance,
            'total': cohort.count(),
        }

    def _average_days_per_phase(self, start, end):
        """
        Activity: phases *finished* inside the window, and how long each took.

        A phase's end is the moment its sign-off was approved -- that is what
        completes it (ProjectSerializer.update refuses COMPLETE without one),
        so it's the only timestamp that means "this phase is done". The next
        phase's start_at is the fallback for anything completed before
        sign-offs were recorded that way.
        """
        results = []
        for phase in PHASES:
            durations = []
            decided = ApprovalRequest.objects.filter(
                request_type=PHASE_SIGNOFF_TYPES[phase],
                status=ApprovalRequest.Status.APPROVED,
                decided_at__range=(start, end),
            ).select_related('project')

            for approval in decided:
                project = approval.project
                if project is None:
                    continue
                started = getattr(project, f'phase_{phase}_started_at')
                finished = approval.decided_at
                if finished is None and phase < 4:
                    finished = getattr(project, f'phase_{phase + 1}_started_at')
                duration = _days_between(started, finished)
                if duration is not None and duration >= 0:
                    durations.append(duration)

            results.append({
                'phase': phase,
                'average_days': _mean(durations),
                'completed': len(durations),
            })
        return results

    # -- people -----------------------------------------------------------

    def _task_stats(self, requirements):
        """
        Shared by the rep and PM tables: how many of these tasks completed,
        and how long they took.

        A task has no start of its own, so "days to complete" is measured
        from the moment its phase began -- the point at which the work could
        first have been picked up.
        """
        completed = 0
        durations = []
        for requirement in requirements:
            completed += 1
            started = getattr(requirement.project, f'phase_{requirement.phase}_started_at', None)
            duration = _days_between(started, requirement.completed_at)
            if duration is not None and duration >= 0:
                durations.append(duration)
        return completed, _mean(durations)

    def _per_rep(self, start, end):
        reps = User.objects.filter(role=User.Role.SALES_REP).order_by('username')
        rows = []

        for rep in reps:
            # Activity: tasks in the rep's own phases, on leads assigned to
            # them, completed inside the window.
            completed_tasks = PhaseRequirement.objects.filter(
                phase__in=REP_PHASES,
                project__lead__assigned_to=rep,
                status=PhaseRequirement.Status.COMPLETED,
                completed_at__range=(start, end),
            ).select_related('project')
            tasks_completed, average_days = self._task_stats(completed_tasks)

            # Inventory: overdue is only ever "as of now" -- a task isn't
            # overdue for a window, it's overdue today or it isn't.
            overdue_candidates = PhaseRequirement.objects.select_related('project').filter(
                phase__in=REP_PHASES,
                project__lead__assigned_to=rep,
            ).exclude(status=PhaseRequirement.Status.NOT_APPLICABLE).filter(
                Q(due_date__isnull=False) | Q(committed_date__isnull=False),
            )
            tasks_overdue = sum(1 for r in overdue_candidates if r.is_overdue)

            signoffs = ApprovalRequest.objects.filter(
                request_type=ApprovalRequest.RequestType.PHASE_1_SIGNOFF,
                requested_by=rep,
                decided_at__range=(start, end),
            ).aggregate(
                approved=Count('id', filter=Q(status=ApprovalRequest.Status.APPROVED)),
                rejected=Count('id', filter=Q(status=ApprovalRequest.Status.REJECTED)),
            )

            rows.append({
                'user_id': rep.id,
                'username': rep.username,
                'leads_owned': Lead.objects.filter(assigned_to=rep, is_archived=False).count(),
                'tasks_completed': tasks_completed,
                'tasks_overdue': tasks_overdue,
                'average_days_to_complete_task': average_days,
                'phase_1_signoffs_approved': signoffs['approved'],
                'phase_1_signoffs_rejected': signoffs['rejected'],
            })
        return rows

    def _per_project_manager(self, cohort, start, end):
        managers = User.objects.filter(role=User.Role.PROJECT_MANAGER).order_by('username')
        rows = []

        for manager in managers:
            per_phase = {}
            for phase in PM_PHASES:
                completed = PhaseRequirement.objects.filter(
                    phase=phase,
                    project__project_manager=manager,
                    status=PhaseRequirement.Status.COMPLETED,
                    completed_at__range=(start, end),
                ).select_related('project')
                per_phase[phase] = self._task_stats(completed)[0]

            # How long Phase 3 (execution) actually ran, for this manager's
            # projects whose Phase 3 sign-off landed in the window.
            execution_durations = []
            for approval in ApprovalRequest.objects.filter(
                request_type=ApprovalRequest.RequestType.PHASE_3_SIGNOFF,
                status=ApprovalRequest.Status.APPROVED,
                decided_at__range=(start, end),
                project__project_manager=manager,
            ).select_related('project'):
                duration = _days_between(approval.project.phase_3_started_at, approval.decided_at)
                if duration is not None and duration >= 0:
                    execution_durations.append(duration)

            rows.append({
                'user_id': manager.id,
                'username': manager.username,
                'projects_managed': cohort.filter(project_manager=manager).count(),
                'phase_2_tasks_completed': per_phase[2],
                'phase_3_tasks_completed': per_phase[3],
                'average_execution_days': _mean(execution_durations),
            })
        return rows

    # -- approvals, budget, interactions ----------------------------------

    def _approval_throughput(self, start, end):
        raised = ApprovalRequest.objects.filter(created_at__range=(start, end)).count()
        decided = ApprovalRequest.objects.filter(decided_at__range=(start, end))
        counts = decided.aggregate(
            approved=Count('id', filter=Q(status=ApprovalRequest.Status.APPROVED)),
            rejected=Count('id', filter=Q(status=ApprovalRequest.Status.REJECTED)),
        )
        decision_times = [
            _days_between(approval.created_at, approval.decided_at)
            for approval in decided.only('created_at', 'decided_at')
        ]
        return {
            'raised': raised,
            'approved': counts['approved'],
            'rejected': counts['rejected'],
            # Two decimals here, unlike the phase durations: approvals are
            # often decided the same day, and 1dp rounds most of them to 0.0.
            'average_days_to_decision': _mean(decision_times, digits=2),
        }

    def _phase_3_budget(self, cohort):
        """
        Inventory (cohort): the money behind projects that got as far as
        execution. "Reaching Phase 3" includes everything past it -- a
        project now in Phase 4 or maintenance reached Phase 3 too.
        """
        reached = cohort.filter(
            Q(current_phase__gte=3) | Q(maintenance=True),
            proposed_budget__isnull=False,
        )
        total = reached.aggregate(total=Sum('proposed_budget'))['total']
        count = reached.count()
        return {
            'projects': count,
            'total_proposed_budget': str(total) if total is not None else None,
            'average_proposed_budget': str(round(total / count, 2)) if total is not None and count else None,
        }

    def _interaction_volume(self, start, end):
        rows = (
            Interaction.objects.filter(occurred_at__range=(start, end))
            .values('outcome')
            .annotate(count=Count('id'))
            .order_by('-count')
        )
        return [
            {'outcome': row['outcome'] or 'UNSPECIFIED', 'count': row['count']}
            for row in rows
        ]
