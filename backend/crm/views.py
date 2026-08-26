from datetime import timedelta

from django.contrib.auth import authenticate, login, logout
from django.db.models import Count, Exists, F, Max, OuterRef, Prefetch, Q, Subquery
from django.utils import timezone
from django.views.decorators.csrf import ensure_csrf_cookie
from rest_framework import generics, status, viewsets
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
    PhaseRequirement,
    Project,
    RequirementTemplate,
    SystemSettings,
    User,
)
from .permissions import (
    ApprovalRequestPermission,
    ArchivableOwnedResourcePermission,
    CompanyPermission,
    ContactPermission,
    ManagementRolePermission,
    ManagementWritePermission,
    RoleBasedAccess,
    SystemSettingsPermission,
)
from .serializers import (
    ActivityEventSerializer,
    ApprovalRequestSerializer,
    CompanySerializer,
    ContactSerializer,
    InteractionSerializer,
    LeadSerializer,
    PhaseRequirementSerializer,
    ProjectSerializer,
    RequirementTemplateSerializer,
    SystemSettingsSerializer,
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
        # they don't own -- see CompanyPermission); nothing to role-filter.
        queryset = Company.objects.select_related('owner')
        return _apply_archived_filter(queryset, self.request, self)

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
    search_fields = ['company__name']
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
            Lead.objects.select_related('assigned_to', 'company', 'contact')
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
            for i in lead.interactions.select_related('created_by')
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
        queryset = Interaction.objects.select_related('lead', 'created_by')
        user = self.request.user
        if user.role == User.Role.SALES_REP:
            queryset = queryset.filter(lead__assigned_to=user)
        return queryset


class ProjectViewSet(viewsets.ModelViewSet):
    serializer_class = ProjectSerializer
    permission_classes = [IsAuthenticated, ArchivableOwnedResourcePermission]
    filterset_fields = ['company', 'lead']
    ordering_fields = ['created_at']
    ordering = ['-created_at']

    def get_queryset(self):
        pending_requests = Prefetch(
            'approval_requests',
            queryset=ApprovalRequest.objects.filter(status=ApprovalRequest.Status.PENDING),
            to_attr='pending_requests',
        )
        queryset = (
            Project.objects.select_related('company', 'deal', 'lead')
            .prefetch_related('requirements', pending_requests)
        )
        user = self.request.user
        if user.role == User.Role.SALES_REP:
            queryset = queryset.filter(company__owner=user)
        return _apply_archived_filter(queryset, self.request, self)

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
    permission_classes = [IsAuthenticated, RoleBasedAccess]
    http_method_names = ['get', 'patch', 'head', 'options']
    filterset_fields = ['project', 'phase']
    ordering_fields = ['phase']
    ordering = ['phase']

    def get_queryset(self):
        queryset = PhaseRequirement.objects.select_related('project__company', 'updated_by', 'confirmed_by')
        user = self.request.user
        if user.role == User.Role.SALES_REP:
            queryset = queryset.filter(project__company__owner=user)
        return queryset


class RequirementTemplateViewSet(viewsets.ModelViewSet):
    serializer_class = RequirementTemplateSerializer
    permission_classes = [IsAuthenticated, ManagementWritePermission]
    filterset_fields = ['phase', 'is_active']
    ordering_fields = ['phase', 'order']
    ordering = ['phase', 'order']
    queryset = RequirementTemplate.objects.all()


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
        if user.role == User.Role.SALES_REP:
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

        if user.role == User.Role.SALES_REP:
            leads = leads.filter(assigned_to=user)
            approvals = approvals.filter(requested_by=user)

        hot_leads_qs = leads.filter(status=Lead.Status.HOT).order_by(F('deal_value').desc(nulls_last=True))
        cold_leads_qs = leads.filter(status=Lead.Status.COLD).order_by('-last_activity_at')
        approaching_cold_qs = leads.filter(
            status=Lead.Status.HOT,
            last_activity_at__gte=now - timedelta(days=cold_lead_days),
            last_activity_at__lte=now - timedelta(days=max(cold_lead_days - 3, 0)),
        ).order_by('last_activity_at')
        pending_approvals_qs = approvals.filter(status=ApprovalRequest.Status.PENDING).order_by('-created_at')

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
        })


class UserViewSet(viewsets.ReadOnlyModelViewSet):
    serializer_class = UserSummarySerializer
    permission_classes = [IsAuthenticated, ManagementRolePermission]
    filterset_fields = ['role']
    queryset = User.objects.all().order_by('username')


class SystemSettingsView(generics.RetrieveUpdateAPIView):
    serializer_class = SystemSettingsSerializer
    permission_classes = [IsAuthenticated, SystemSettingsPermission]
    http_method_names = ['get', 'patch', 'head', 'options']

    def get_object(self):
        return SystemSettings.load()
