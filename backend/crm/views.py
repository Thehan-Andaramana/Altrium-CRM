from django.contrib.auth import authenticate, login, logout
from django.db.models import Count
from django.views.decorators.csrf import ensure_csrf_cookie
from rest_framework import generics, status, viewsets
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response

from .models import Company, Interaction, Lead, SystemSettings, User
from .permissions import ManagementRolePermission, RoleBasedAccess, SystemSettingsPermission
from .serializers import (
    CompanySerializer,
    InteractionSerializer,
    LeadSerializer,
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
