from datetime import timedelta

from django.contrib.auth import authenticate, login, logout
from django.db import transaction
from django.db.models import Count, Exists, F, Max, OuterRef, Prefetch, Q, Subquery
from django.http import FileResponse
from django.utils import timezone
from django.views.decorators.csrf import ensure_csrf_cookie
from rest_framework import generics, mixins, status, viewsets
from rest_framework.decorators import action, api_view, permission_classes
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from .models import (
    ActivityEvent,
    ApprovalRequest,
    Company,
    Contact,
    Deal,
    Interaction,
    Lead,
    Mention,
    PhaseRequirement,
    Project,
    RequirementTemplate,
    SystemSettings,
    TaskAttachment,
    TaskFormField,
    TaskFormResponse,
    User,
)
from .permissions import (
    ApprovalRequestPermission,
    ArchivableOwnedResourcePermission,
    CompanyPermission,
    ContactPermission,
    FULL_ACCESS_ROLES,
    ManagementWritePermission,
    PhaseRequirementPermission,
    RoleBasedAccess,
    SystemSettingsPermission,
    TaskAttachmentPermission,
)
from .serializers import (
    ActivityEventSerializer,
    ApprovalRequestSerializer,
    CalendarTaskSerializer,
    CompanySerializer,
    ContactSerializer,
    InteractionSerializer,
    LeadSerializer,
    MentionSerializer,
    PhaseRequirementSerializer,
    ProjectSerializer,
    RequirementTemplateSerializer,
    SystemSettingsSerializer,
    TaskAttachmentSerializer,
    UserSummarySerializer,
)


def _user_payload(user):
    return {'id': user.id, 'username': user.username, 'role': user.role}


def _apply_archived_filter(queryset, request, view):
    # archive/unarchive act on a record regardless of its current archived
    # state, so they need to bypass this filter entirely. DELETE also needs
    # to see archived records -- that's the only state SYSTEM_ADMIN is ever
    # allowed to delete, and has_object_permission (not this filter) is what
    # actually rejects a DELETE on a non-archived record.
    if view.action in ('archive', 'unarchive') or request.method == 'DELETE':
        return queryset
    if request.query_params.get('include_archived', '').lower() == 'true':
        return queryset
    return queryset.filter(is_archived=False)


def _do_archive(request, instance, serializer_class):
    reason = (request.data.get('archive_reason') or '').strip()
    if not reason:
        return Response({'archive_reason': 'A reason is required to archive.'}, status=status.HTTP_400_BAD_REQUEST)
    if instance.is_archived:
        return Response({'detail': 'Already archived.'}, status=status.HTTP_400_BAD_REQUEST)

    instance.is_archived = True
    instance.archived_by = request.user
    instance.archived_at = timezone.now()
    instance.archive_reason = reason
    instance.save()
    return Response(serializer_class(instance, context={'request': request}).data)


def _do_unarchive(request, instance, serializer_class):
    if not instance.is_archived:
        return Response({'detail': 'Not archived.'}, status=status.HTTP_400_BAD_REQUEST)

    instance.is_archived = False
    instance.archived_by = None
    instance.archived_at = None
    instance.archive_reason = ''
    instance.save()
    return Response(serializer_class(instance, context={'request': request}).data)


@api_view(['GET'])
@permission_classes([AllowAny])
@ensure_csrf_cookie
def csrf(request):
    return Response({'detail': 'CSRF cookie set'})


@api_view(['POST'])
@permission_classes([AllowAny])
def login_view(request):
    username = request.data.get('username')
    password = request.data.get('password')
    user = authenticate(request, username=username, password=password)
    if user is None:
        return Response({'detail': 'Invalid credentials'}, status=status.HTTP_401_UNAUTHORIZED)
    login(request, user)
    # "Remember me" is the login form's checkbox, and it decides how long the
    # session outlives the browser. Left out entirely (an older client, or a
    # scripted login) it defaults to True, which is the behaviour this
    # endpoint has always had -- Django's own default of a persistent cookie
    # for SESSION_COOKIE_AGE. Unchecking it opts into a session cookie that
    # dies with the browser instead.
    if request.data.get('remember', True) is False:
        request.session.set_expiry(0)
    return Response(_user_payload(user))


@api_view(['POST'])
def logout_view(request):
    logout(request)
    return Response({'detail': 'Logged out'})


@api_view(['GET'])
def me(request):
    return Response(_user_payload(request.user))


class CompanyViewSet(viewsets.ModelViewSet):
    serializer_class = CompanySerializer
    permission_classes = [IsAuthenticated, CompanyPermission]
    filterset_fields = ['industry']
    search_fields = ['name']
    ordering_fields = ['created_at']
    ordering = ['-created_at']

    def get_queryset(self):
        # Every role can read every company (reps just can't write to ones
        # they're not owner/assigned-lead on -- see CompanyPermission).
        # ?mine=true narrows the list to companies the requesting user owns
        # or has an assigned lead against -- Companies.jsx defaults
        # SALES_REP to this so their list isn't every company in the system;
        # global search deliberately never sends it, so search still finds
        # any company regardless of role.
        queryset = Company.objects.select_related('owner')
        queryset = _apply_archived_filter(queryset, self.request, self)
        if self.request.query_params.get('mine') == 'true':
            user = self.request.user
            queryset = queryset.filter(Q(owner=user) | Q(leads__assigned_to=user)).distinct()
        return queryset

    @action(detail=True, methods=['post'])
    def archive(self, request, pk=None):
        company = self.get_object()
        response = _do_archive(request, company, CompanySerializer)
        if response.status_code == status.HTTP_200_OK:
            # Cascades to the company's leads and projects.
            cascade_reason = f'Cascaded from company archive: {company.archive_reason}'
            cascaded_lead_ids = list(company.leads.filter(is_archived=False).values_list('id', flat=True))
            company.leads.filter(is_archived=False).update(
                is_archived=True,
                archived_by=request.user,
                archived_at=company.archived_at,
                archive_reason=cascade_reason,
            )
            company.projects.filter(is_archived=False).update(
                is_archived=True,
                archived_by=request.user,
                archived_at=company.archived_at,
                archive_reason=cascade_reason,
            )
            ActivityEvent.objects.bulk_create([
                ActivityEvent(
                    lead_id=lead_id,
                    category=ActivityEvent.Category.DESTRUCTIVE,
                    description=f'Lead archived: {cascade_reason}',
                    actor=request.user,
                )
                for lead_id in cascaded_lead_ids
            ])
        return response

    @action(detail=True, methods=['post'])
    def unarchive(self, request, pk=None):
        return _do_unarchive(request, self.get_object(), CompanySerializer)


class LeadViewSet(viewsets.ModelViewSet):
    serializer_class = LeadSerializer
    permission_classes = [IsAuthenticated, ArchivableOwnedResourcePermission]
    filterset_fields = ['status', 'assigned_to', 'company']
    search_fields = ['name', 'company__name']
    ordering_fields = ['created_at']
    ordering = ['-created_at']

    def get_queryset(self):
        # Neither Lead nor Deal has a direct FK to the other; both link to a
        # Contact, so that's used as the bridge to find "this lead's deal".
        # Project *does* now link directly to Lead (a Project auto-generates
        # whenever a Lead is created), so has_project no longer needs that
        # bridge -- though that also means it's ~always true going forward.
        matching_deals = Deal.objects.filter(contact_id=OuterRef('contact_id')).order_by('-id')
        queryset = (
            Lead.objects.select_related(
                'assigned_to', 'company', 'contact',
                # current_phase / project_manager_username on the serializer
                # read through to the project -- without these, listing the
                # pipeline is two extra queries per lead.
                'project', 'project__project_manager',
            )
            .annotate(
                interaction_count=Count('interactions', distinct=True),
                deal_stage=Subquery(matching_deals.values('stage')[:1]),
                has_project=Exists(Project.objects.filter(lead_id=OuterRef('pk'))),
            )
        )
        user = self.request.user
        if user.role == User.Role.SALES_REP:
            queryset = queryset.filter(assigned_to=user)
        return _apply_archived_filter(queryset, self.request, self)

    @action(detail=True, methods=['post'])
    def archive(self, request, pk=None):
        lead = self.get_object()
        response = _do_archive(request, lead, LeadSerializer)
        if response.status_code == status.HTTP_200_OK:
            ActivityEvent.record(
                lead, ActivityEvent.Category.DESTRUCTIVE, f'Lead archived: {lead.archive_reason}',
                actor=request.user,
            )
        return response

    @action(detail=True, methods=['post'])
    def unarchive(self, request, pk=None):
        lead = self.get_object()
        response = _do_unarchive(request, lead, LeadSerializer)
        if response.status_code == status.HTTP_200_OK:
            ActivityEvent.record(
                lead, ActivityEvent.Category.DESTRUCTIVE, 'Lead unarchived', actor=request.user,
            )
        return response

    @action(detail=True, methods=['get'])
    def timeline(self, request, pk=None):
        lead = self.get_object()
        tagged = [
            ('INTERACTION', 'INTERACTION', i.occurred_at, i)
            for i in lead.interactions.select_related('created_by', 'lead__project')
            .prefetch_related('mentions__user')
        ] + [
            ('APPROVAL_REQUEST', 'APPROVAL', a.created_at, a)
            for a in ApprovalRequest.objects.filter(
                Q(lead=lead) | Q(project__lead=lead)
            ).select_related('requested_by', 'decided_by')
        ] + [
            ('ACTIVITY_EVENT', e.category, e.occurred_at, e)
            for e in lead.activity_events.select_related('actor')
        ]
        tagged.sort(key=lambda entry: entry[2], reverse=True)

        serializer_map = {
            'INTERACTION': InteractionSerializer,
            'APPROVAL_REQUEST': ApprovalRequestSerializer,
            'ACTIVITY_EVENT': ActivityEventSerializer,
        }
        ctx = {'request': request}
        entries = [
            {**serializer_map[entry_type](obj, context=ctx).data, 'entry_type': entry_type, 'event_category': event_category}
            for entry_type, event_category, _timestamp, obj in tagged
        ]
        return Response(entries)


class ContactViewSet(viewsets.ModelViewSet):
    serializer_class = ContactSerializer
    permission_classes = [IsAuthenticated, ContactPermission]
    filterset_fields = ['company']
    ordering_fields = ['name']
    ordering = ['name']

    def get_queryset(self):
        # Every role can read every contact (reps just can't write to ones on
        # companies where they don't have an assigned lead -- see
        # ContactPermission); nothing to role-filter.
        queryset = Contact.objects.select_related('company')
        return _apply_archived_filter(queryset, self.request, self)

    @action(detail=True, methods=['post'])
    def archive(self, request, pk=None):
        contact = self.get_object()
        response = _do_archive(request, contact, ContactSerializer)
        if response.status_code == status.HTTP_200_OK:
            self._record_for_linked_leads(contact, f'Contact archived: {contact.name}', request.user)
        return response

    @action(detail=True, methods=['post'])
    def unarchive(self, request, pk=None):
        contact = self.get_object()
        response = _do_unarchive(request, contact, ContactSerializer)
        if response.status_code == status.HTTP_200_OK:
            self._record_for_linked_leads(contact, f'Contact unarchived: {contact.name}', request.user)
        return response

    @staticmethod
    def _record_for_linked_leads(contact, description, actor):
        # A Contact isn't scoped to one Lead, so every lead currently
        # pointing at it (usually 0 or 1, occasionally more) gets the entry.
        for lead in Lead.objects.filter(contact=contact):
            ActivityEvent.record(lead, ActivityEvent.Category.DESTRUCTIVE, description, actor=actor)


class InteractionViewSet(viewsets.ModelViewSet):
    serializer_class = InteractionSerializer
    permission_classes = [IsAuthenticated, RoleBasedAccess]
    filterset_fields = ['lead']
    ordering_fields = ['occurred_at']
    ordering = ['-occurred_at']

    def get_queryset(self):
        queryset = (
            Interaction.objects.select_related('lead', 'lead__project', 'created_by')
            .prefetch_related('mentions__user')
        )
        user = self.request.user
        if user.role == User.Role.SALES_REP:
            queryset = queryset.filter(lead__assigned_to=user)
        return queryset


class ProjectViewSet(viewsets.ModelViewSet):
    serializer_class = ProjectSerializer
    permission_classes = [IsAuthenticated, ArchivableOwnedResourcePermission]
    filterset_fields = ['company', 'lead']
    # board_order is orderable but not the default -- the board asks for
    # ?ordering=board_order,-created_at explicitly, and every other caller
    # keeps the newest-first list it already had.
    ordering_fields = ['created_at', 'board_order']
    ordering = ['-created_at']

    def get_queryset(self):
        pending_requests = Prefetch(
            'approval_requests',
            queryset=ApprovalRequest.objects.filter(status=ApprovalRequest.Status.PENDING),
            to_attr='pending_requests',
        )
        queryset = (
            Project.objects.select_related(
                'company', 'deal', 'lead', 'lead__assigned_to', 'project_manager',
            )
            .prefetch_related('requirements', pending_requests)
        )
        user = self.request.user
        if user.role == User.Role.SALES_REP:
            # A rep can read a project either through owning the company or
            # through being assigned the lead it belongs to -- company
            # ownership alone used to be the only path in, which meant a rep
            # assigned a lead on a company they don't own got no project back
            # (and so no phase tracker at all).
            queryset = queryset.filter(Q(company__owner=user) | Q(lead__assigned_to=user))
        elif user.role == User.Role.PROJECT_MANAGER:
            queryset = queryset.filter(project_manager=user)
        return _apply_archived_filter(queryset, self.request, self)

    @action(detail=False, methods=['post'])
    def reorder(self, request):
        """
        POST /api/projects/reorder/ with {"order": [<project id>, ...]}.

        Writes board_order for a board column in one request, so dragging a
        card doesn't fan out into one PATCH per card behind it. Only
        board_order is ever written here -- a phase still moves solely
        through an approved sign-off (see ProjectSerializer.update), and the
        same-column check below refuses an order that would span two
        columns, so the board's rule holds server-side and not just in the UI.
        """
        ids = request.data.get('order')
        if not isinstance(ids, list) or not all(isinstance(pk, int) for pk in ids):
            return Response(
                {'order': 'Expected a list of project ids.'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if len(set(ids)) != len(ids):
            return Response({'order': 'Ids must be unique.'}, status=status.HTTP_400_BAD_REQUEST)

        # get_queryset() is already role-scoped, so an id the requester
        # can't see simply isn't found; check_object_permissions then
        # applies the same write rule a PATCH would (a rep on their own
        # leads, the managing PM, management anywhere -- SYSTEM_ADMIN is
        # read-only on projects and is refused here too).
        projects = {project.id: project for project in self.get_queryset().filter(id__in=ids)}
        missing = [pk for pk in ids if pk not in projects]
        if missing:
            return Response({'order': 'Unknown project in order.'}, status=status.HTTP_404_NOT_FOUND)

        ordered = [projects[pk] for pk in ids]
        for project in ordered:
            self.check_object_permissions(request, project)

        columns = {(project.maintenance, project.current_phase) for project in ordered}
        if len(columns) > 1:
            return Response(
                {'order': 'Cards can only be reordered within one phase -- phases advance through approval.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        for position, project in enumerate(ordered):
            project.board_order = position
        Project.objects.bulk_update(ordered, ['board_order'])

        return Response({'updated': len(ordered)})

    @action(detail=True, methods=['post'])
    def archive(self, request, pk=None):
        project = self.get_object()
        response = _do_archive(request, project, ProjectSerializer)
        if response.status_code == status.HTTP_200_OK:
            ActivityEvent.record(
                project.lead, ActivityEvent.Category.DESTRUCTIVE, f'Project archived: {project.archive_reason}',
                actor=request.user,
            )
        return response

    @action(detail=True, methods=['post'])
    def unarchive(self, request, pk=None):
        project = self.get_object()
        response = _do_unarchive(request, project, ProjectSerializer)
        if response.status_code == status.HTTP_200_OK:
            ActivityEvent.record(
                project.lead, ActivityEvent.Category.DESTRUCTIVE, 'Project unarchived', actor=request.user,
            )
        return response


class PhaseRequirementViewSet(viewsets.ModelViewSet):
    serializer_class = PhaseRequirementSerializer
    permission_classes = [IsAuthenticated, PhaseRequirementPermission]
    http_method_names = ['get', 'post', 'patch', 'delete', 'head', 'options']
    filterset_fields = ['project', 'phase']
    ordering_fields = ['phase']
    ordering = ['phase']

    def get_queryset(self):
        queryset = PhaseRequirement.objects.select_related(
            'project__company', 'updated_by', 'confirmed_by', 'template',
            # responsible_user reads through to one of these two depending
            # on the phase -- without them, serializing a phase's worth of
            # tasks is a query per row.
            'project__lead__assigned_to', 'project__project_manager',
        ).prefetch_related('template__form_fields', 'custom_form_fields', 'form_responses')
        user = self.request.user
        if user.role == User.Role.SALES_REP:
            # Same owner-or-assigned-lead access as ProjectViewSet above.
            queryset = queryset.filter(Q(project__company__owner=user) | Q(project__lead__assigned_to=user))
        elif user.role == User.Role.PROJECT_MANAGER:
            queryset = queryset.filter(project__project_manager=user)
        return queryset

    @action(detail=True, methods=['post'])
    def answers(self, request, pk=None):
        # get_object() re-runs get_queryset() + has_object_permission() --
        # the same "can edit this task" check as everywhere else, since
        # editing a response is only allowed for whoever can edit the task.
        requirement = self.get_object()
        responses = request.data.get('responses')
        if not isinstance(responses, list):
            return Response(
                {'responses': 'Expected a list of {field, value} objects.'}, status=status.HTTP_400_BAD_REQUEST,
            )

        valid_fields = {f.id: f for f in requirement.form_fields}
        changed_labels = []
        for item in responses:
            field_id = item.get('field')
            if field_id not in valid_fields:
                return Response(
                    {'responses': f'Field {field_id} does not belong to this task.'},
                    status=status.HTTP_400_BAD_REQUEST,
                )

        for item in responses:
            field = valid_fields[item.get('field')]
            value = item.get('value') or ''
            response_obj, created = TaskFormResponse.objects.get_or_create(
                requirement=requirement, field=field, defaults={'value': value, 'answered_by': request.user},
            )
            if created:
                changed_labels.append(field.label)
            elif response_obj.value != value:
                response_obj.value = value
                response_obj.answered_by = request.user
                response_obj.save(update_fields=['value', 'answered_by', 'answered_at'])
                changed_labels.append(field.label)

        if changed_labels:
            ActivityEvent.record(
                requirement.project.lead,
                ActivityEvent.Category.PHASE,
                f'Updated form answers for "{requirement.label}": {", ".join(changed_labels)}',
                actor=request.user,
            )

        # refresh_from_db() wouldn't be enough here -- it reloads the
        # instance's own fields but leaves the prefetched form_responses
        # queryset (from get_object()) cached and stale. Re-fetching through
        # get_queryset() gets a clean instance with correct prefetches.
        requirement = self.get_queryset().get(pk=requirement.pk)
        return Response(self.get_serializer(requirement).data)


class TaskAttachmentViewSet(viewsets.ModelViewSet):
    serializer_class = TaskAttachmentSerializer
    permission_classes = [IsAuthenticated, TaskAttachmentPermission]
    http_method_names = ['get', 'post', 'delete', 'head', 'options']
    filterset_fields = ['requirement']
    ordering_fields = ['uploaded_at']
    ordering = ['-uploaded_at']

    def get_queryset(self):
        # Same project-scoping as PhaseRequirementViewSet, just one hop
        # further through the FK.
        queryset = TaskAttachment.objects.select_related(
            'requirement__project__company', 'requirement__project__lead', 'uploaded_by',
        )
        user = self.request.user
        if user.role == User.Role.SALES_REP:
            queryset = queryset.filter(
                Q(requirement__project__company__owner=user) | Q(requirement__project__lead__assigned_to=user),
            )
        elif user.role == User.Role.PROJECT_MANAGER:
            queryset = queryset.filter(requirement__project__project_manager=user)
        return queryset

    @action(detail=True, methods=['get'])
    def download(self, request, pk=None):
        # get_object() applies get_queryset() + has_object_permission() --
        # the exact same visibility check as everywhere else this data is
        # reached, re-run here rather than trusting a raw media URL (which
        # django.views.static.serve would hand out to anyone, authenticated
        # or not).
        attachment = self.get_object()
        if attachment.kind != TaskAttachment.Kind.FILE or not attachment.file:
            return Response(
                {'detail': 'This attachment has no file to download.'}, status=status.HTTP_400_BAD_REQUEST,
            )
        return FileResponse(
            attachment.file.open('rb'),
            content_type=attachment.content_type or 'application/octet-stream',
            as_attachment=False,
            filename=attachment.original_filename or attachment.file.name,
        )


class RequirementTemplateViewSet(viewsets.ModelViewSet):
    serializer_class = RequirementTemplateSerializer
    permission_classes = [IsAuthenticated, ManagementWritePermission]
    filterset_fields = ['phase', 'is_active']
    ordering_fields = ['phase', 'order']
    ordering = ['phase', 'order']
    queryset = RequirementTemplate.objects.prefetch_related('form_fields')

    @action(detail=True, methods=['post'])
    def copy(self, request, pk=None):
        """
        POST /api/requirement-templates/{id}/copy/ with {"phase": N}.

        Puts a copy of this template into another phase -- what dragging one
        out of the settings library into a phase does. The copy is active
        from the start (there would be no point otherwise) and takes the
        original's form fields with it, because a template without the form
        it asks for is a different task.

        A PATCH can move a template between phases, but only by taking it
        out of the one it is in; this is how the same task ends up in two
        phases at once.
        """
        source = self.get_object()
        phase = request.data.get('phase')
        if phase not in (1, 2, 3, 4):
            return Response(
                {'phase': 'Choose a phase between 1 and 4.'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if RequirementTemplate.objects.filter(phase=phase, label=source.label, is_active=True).exists():
            return Response(
                {'detail': f'"{source.label}" is already active in phase {phase}.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        with transaction.atomic():
            last_order = RequirementTemplate.objects.filter(phase=phase).aggregate(
                last=Max('order'),
            )['last']
            copy = RequirementTemplate.objects.create(
                phase=phase,
                label=source.label,
                description=source.description,
                order=(last_order or 0) + 1,
                confirmation_authority=source.confirmation_authority,
                client_facing=source.client_facing,
                default_duration_days=source.default_duration_days,
                is_active=True,
            )
            TaskFormField.objects.bulk_create([
                TaskFormField(
                    template=copy,
                    label=field.label,
                    field_type=field.field_type,
                    options=field.options,
                    required=field.required,
                    order=field.order,
                    help_text=field.help_text,
                )
                for field in source.form_fields.all()
            ])

        serializer = self.get_serializer(copy)
        return Response(serializer.data, status=status.HTTP_201_CREATED)


class ApprovalRequestViewSet(viewsets.ModelViewSet):
    serializer_class = ApprovalRequestSerializer
    permission_classes = [IsAuthenticated, ApprovalRequestPermission]
    http_method_names = ['get', 'post', 'patch', 'head', 'options']
    filterset_fields = ['status', 'request_type']
    ordering_fields = ['created_at']
    ordering = ['-created_at']

    def get_queryset(self):
        queryset = ApprovalRequest.objects.select_related(
            'lead', 'lead__company', 'lead__contact',
            'project', 'project__company', 'project__lead__contact',
            'requested_by', 'decided_by',
        )
        user = self.request.user
        if user.role == User.Role.PROJECT_MANAGER:
            queryset = queryset.filter(Q(requested_by=user) | Q(project__project_manager=user))
        elif user.role not in FULL_ACCESS_ROLES:
            # Everyone else (SALES_REP, and any other non-management role)
            # only sees requests they submitted themselves -- without this,
            # any role outside FULL_ACCESS_ROLES fell through to the
            # unfiltered queryset and could read the entire table.
            queryset = queryset.filter(requested_by=user)
        return queryset


class DashboardView(APIView):
    permission_classes = [IsAuthenticated]
    HOT_LEADS_LIMIT = 5

    def get(self, request):
        user = request.user
        now = timezone.now()
        cold_lead_days = SystemSettings.load().cold_lead_days

        leads = Lead.objects.filter(is_archived=False).select_related('company', 'contact', 'assigned_to').annotate(
            deal_value=Max('company__deals__value'),
            interaction_count=Count('interactions', distinct=True),
        )
        approvals = ApprovalRequest.objects.select_related(
            'lead', 'lead__company', 'lead__contact',
            'project', 'project__company', 'project__lead__contact',
            'requested_by', 'decided_by',
        )
        # Broad pre-filter only (excludes tasks that can never be overdue --
        # no date set at all, or already NOT_APPLICABLE); is_overdue itself
        # also weighs confirmation state, which isn't a single DB column, so
        # it's evaluated in Python below rather than duplicated as a Q().
        overdue_task_candidates = PhaseRequirement.objects.select_related(
            'project', 'project__lead', 'project__company',
        ).exclude(status=PhaseRequirement.Status.NOT_APPLICABLE).filter(
            Q(due_date__isnull=False) | Q(committed_date__isnull=False),
        )
        # "Active" = live work: not archived, and not yet handed over into
        # maintenance. Scoped below the same way everything else here is.
        active_projects = Project.objects.filter(is_archived=False, maintenance=False)

        if user.role == User.Role.SALES_REP:
            leads = leads.filter(assigned_to=user)
            approvals = approvals.filter(requested_by=user)
            overdue_task_candidates = overdue_task_candidates.filter(project__lead__assigned_to=user)
            # Same owner-or-assigned-lead reach a rep has in ProjectViewSet.
            active_projects = active_projects.filter(Q(company__owner=user) | Q(lead__assigned_to=user))
        elif user.role == User.Role.PROJECT_MANAGER:
            active_projects = active_projects.filter(project_manager=user)

        hot_leads_qs = leads.filter(status=Lead.Status.HOT).order_by(F('deal_value').desc(nulls_last=True))
        cold_leads_qs = leads.filter(status=Lead.Status.COLD).order_by('-last_activity_at')
        approaching_cold_qs = leads.filter(
            status=Lead.Status.HOT,
            last_activity_at__gte=now - timedelta(days=cold_lead_days),
            last_activity_at__lte=now - timedelta(days=max(cold_lead_days - 3, 0)),
        ).order_by('last_activity_at')
        pending_approvals_qs = approvals.filter(status=ApprovalRequest.Status.PENDING).order_by('-created_at')
        overdue_tasks = sorted(
            (r for r in overdue_task_candidates if r.is_overdue),
            key=lambda r: r.effective_due_date,
        )

        ctx = {'request': request}
        return Response({
            'hot_leads': {
                'count': hot_leads_qs.count(),
                'results': LeadSerializer(hot_leads_qs[:self.HOT_LEADS_LIMIT], many=True, context=ctx).data,
            },
            'cold_leads': {
                'count': cold_leads_qs.count(),
                'results': LeadSerializer(cold_leads_qs, many=True, context=ctx).data,
            },
            'approaching_cold_leads': {
                'count': approaching_cold_qs.count(),
                'results': LeadSerializer(approaching_cold_qs, many=True, context=ctx).data,
            },
            'pending_approvals': {
                'count': pending_approvals_qs.count(),
                'results': ApprovalRequestSerializer(pending_approvals_qs, many=True, context=ctx).data,
            },
            'overdue_tasks': {
                'count': len(overdue_tasks),
                'results': PhaseRequirementSerializer(overdue_tasks, many=True, context=ctx).data,
            },
            # Count only -- the dashboard's projects stat card links through
            # to the board for the list itself.
            'active_projects': {'count': active_projects.count()},
        })


class SidebarBadgeView(APIView):
    """
    GET /api/badges/ -- the two counts the sidebar shows, and nothing else.

    The sidebar used to get these by fetching the whole approvals list and
    the whole calendar month, then counting client-side: a quarter of a
    megabyte on every page load to render two small numbers. Scoping is
    identical to those endpoints, so the numbers are the same; only the
    payload is different.
    """

    permission_classes = [IsAuthenticated]

    def get(self, request):
        user = request.user

        approvals = ApprovalRequest.objects.filter(status=ApprovalRequest.Status.PENDING)
        if user.role == User.Role.PROJECT_MANAGER:
            approvals = approvals.filter(Q(requested_by=user) | Q(project__project_manager=user))
        elif user.role not in FULL_ACCESS_ROLES:
            approvals = approvals.filter(requested_by=user)

        # Same candidate set as CalendarView: is_overdue weighs confirmation
        # state as well as dates, so it can't be a pure DB filter -- but the
        # rows are narrowed hard first and only the fields it reads are
        # loaded, rather than serialising every task for the month.
        overdue_candidates = PhaseRequirement.objects.select_related(
            'project__lead', 'project__project_manager', 'confirmed_by',
        ).exclude(status=PhaseRequirement.Status.NOT_APPLICABLE).filter(
            Q(due_date__isnull=False) | Q(committed_date__isnull=False),
        )
        if user.role == User.Role.SALES_REP:
            overdue_candidates = overdue_candidates.filter(project__lead__assigned_to=user)
        elif user.role == User.Role.PROJECT_MANAGER:
            overdue_candidates = overdue_candidates.filter(project__project_manager=user)

        return Response({
            'pending_approvals': approvals.count(),
            'overdue_tasks': sum(1 for requirement in overdue_candidates if requirement.is_overdue),
        })


class CalendarView(APIView):
    """
    GET /api/calendar/?year=&month=  (both default to the current month).

    Role-scoped the same way as the dashboard's overdue-tasks list, except a
    PROJECT_MANAGER gets a real scope here (the dashboard never gave them
    one, since it has no PM-specific branch): a rep sees tasks on leads
    assigned to them, a PM sees tasks on projects they manage, and every
    other role (management, admin) sees everything -- matching "reps see
    their leads', PMs see their projects', managers see everything".
    """

    permission_classes = [IsAuthenticated]

    def get(self, request):
        user = request.user
        today = timezone.localdate()
        try:
            year = int(request.query_params.get('year', today.year))
            month = int(request.query_params.get('month', today.month))
        except ValueError:
            return Response({'detail': 'year and month must be integers.'}, status=status.HTTP_400_BAD_REQUEST)
        if not 1 <= month <= 12:
            return Response({'detail': 'month must be between 1 and 12.'}, status=status.HTTP_400_BAD_REQUEST)

        # Same broad pre-filter as the dashboard's overdue-tasks query --
        # effective_due_date isn't a DB column (it's min(due_date,
        # committed_date) in Python), so the month itself is also filtered
        # in Python below, after this candidate set is scoped and fetched.
        candidates = PhaseRequirement.objects.select_related(
            'project__lead', 'project__project_manager', 'confirmed_by',
        ).exclude(status=PhaseRequirement.Status.NOT_APPLICABLE).filter(
            Q(due_date__isnull=False) | Q(committed_date__isnull=False),
        )
        if user.role == User.Role.SALES_REP:
            candidates = candidates.filter(project__lead__assigned_to=user)
        elif user.role == User.Role.PROJECT_MANAGER:
            candidates = candidates.filter(project__project_manager=user)

        tasks = sorted(
            (
                r for r in candidates
                if r.effective_due_date is not None
                and r.effective_due_date.year == year
                and r.effective_due_date.month == month
            ),
            key=lambda r: r.effective_due_date,
        )
        return Response(CalendarTaskSerializer(tasks, many=True, context={'request': request}).data)


class UserViewSet(viewsets.ReadOnlyModelViewSet):
    # Read-only for any authenticated user (not just management) -- the
    # @mention autocomplete needs every role, including SALES_REP, to be able
    # to list users. Existing management-only actions (e.g. reassigning a
    # lead's owner) stay gated by their own view's permission, not this one.
    serializer_class = UserSummarySerializer
    permission_classes = [IsAuthenticated]
    filterset_fields = ['role']
    queryset = User.objects.all().order_by('username')


class MentionViewSet(
    mixins.ListModelMixin, mixins.RetrieveModelMixin, mixins.UpdateModelMixin, viewsets.GenericViewSet,
):
    """
    The notification centre, backed by Mention rows. No create/destroy --
    mentions are only ever created as a side effect of Interaction.save().

    list: the current user's *unread* mentions only (the notification
    centre's whole point). retrieve/update stay reachable for an
    already-read mention too (scoped to the user either way) so marking one
    read twice is a harmless no-op rather than a 404.
    """

    serializer_class = MentionSerializer
    permission_classes = [IsAuthenticated]
    http_method_names = ['get', 'patch', 'post', 'head', 'options']

    def get_queryset(self):
        queryset = Mention.objects.filter(user=self.request.user).select_related(
            'interaction__lead', 'created_by', 'task',
        )
        if self.action == 'list':
            queryset = queryset.filter(read_at__isnull=True)
        return queryset

    def update(self, request, *args, **kwargs):
        # Only ever transitions read_at from null to now -- there's nothing
        # else on a Mention for a client to change, so every field is
        # read-only on the serializer and the actual write happens here.
        instance = self.get_object()
        if instance.read_at is None:
            instance.read_at = timezone.now()
            instance.save(update_fields=['read_at'])
        return Response(self.get_serializer(instance).data)

    @action(detail=False, methods=['get'])
    def unread_count(self, request):
        count = Mention.objects.filter(user=request.user, read_at__isnull=True).count()
        return Response({'unread_count': count})

    @action(detail=False, methods=['post'], url_path='mark-all-read')
    def mark_all_read(self, request):
        Mention.objects.filter(user=request.user, read_at__isnull=True).update(read_at=timezone.now())
        return Response({'unread_count': 0})


class SystemSettingsView(generics.RetrieveUpdateAPIView):
    serializer_class = SystemSettingsSerializer
    permission_classes = [IsAuthenticated, SystemSettingsPermission]
    http_method_names = ['get', 'patch', 'head', 'options']

    def get_object(self):
        return SystemSettings.load()
