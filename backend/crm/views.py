from datetime import timedelta

from django.contrib.auth import authenticate, login, logout
from django.db.models import Count, F, Max
from django.utils import timezone
from django.views.decorators.csrf import ensure_csrf_cookie
from rest_framework import generics, status, viewsets
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from .models import ApprovalRequest, Company, Interaction, Lead, Project, SystemSettings, User
from .permissions import (
    ApprovalRequestPermission,
    ManagementRolePermission,
    RoleBasedAccess,
    SystemSettingsPermission,
)
from .serializers import (
    ApprovalRequestSerializer,
    CompanySerializer,
    InteractionSerializer,
    LeadSerializer,
    ProjectSerializer,
    SystemSettingsSerializer,
    UserSummarySerializer,
)


def _user_payload(user):
    return {'id': user.id, 'username': user.username, 'role': user.role}


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
    permission_classes = [IsAuthenticated, RoleBasedAccess]
    filterset_fields = ['industry']
    search_fields = ['name']
    ordering_fields = ['created_at']
    ordering = ['-created_at']

    def get_queryset(self):
        queryset = Company.objects.select_related('owner')
        user = self.request.user
        if user.role == User.Role.SALES_REP:
            queryset = queryset.filter(owner=user)
        return queryset


class LeadViewSet(viewsets.ModelViewSet):
    serializer_class = LeadSerializer
    permission_classes = [IsAuthenticated, RoleBasedAccess]
    filterset_fields = ['status', 'assigned_to']
    search_fields = ['company__name']
    ordering_fields = ['created_at']
    ordering = ['-created_at']

    def get_queryset(self):
        queryset = (
            Lead.objects.select_related('assigned_to', 'company', 'contact')
            .annotate(interaction_count=Count('interactions', distinct=True))
        )
        user = self.request.user
        if user.role == User.Role.SALES_REP:
            queryset = queryset.filter(assigned_to=user)
        return queryset


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
    permission_classes = [IsAuthenticated, RoleBasedAccess]
    filterset_fields = ['company']
    ordering_fields = ['created_at']
    ordering = ['-created_at']

    def get_queryset(self):
        queryset = Project.objects.select_related('company', 'deal')
        user = self.request.user
        if user.role == User.Role.SALES_REP:
            queryset = queryset.filter(company__owner=user)
        return queryset


class ApprovalRequestViewSet(viewsets.ModelViewSet):
    serializer_class = ApprovalRequestSerializer
    permission_classes = [IsAuthenticated, ApprovalRequestPermission]
    http_method_names = ['get', 'post', 'patch', 'head', 'options']
    filterset_fields = ['status', 'request_type']
    ordering_fields = ['created_at']
    ordering = ['-created_at']

    def get_queryset(self):
        queryset = ApprovalRequest.objects.select_related('lead', 'project', 'requested_by', 'decided_by')
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

        leads = Lead.objects.select_related('company', 'contact', 'assigned_to').annotate(
            deal_value=Max('company__deals__value'),
            interaction_count=Count('interactions', distinct=True),
        )
        approvals = ApprovalRequest.objects.select_related('lead', 'project', 'requested_by', 'decided_by')

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
