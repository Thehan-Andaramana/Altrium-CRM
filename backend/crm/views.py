from django.contrib.auth import authenticate, login, logout
from django.views.decorators.csrf import ensure_csrf_cookie
from rest_framework import status, viewsets
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response

from .models import Company, Lead, User
from .permissions import RoleBasedAccess
from .serializers import CompanySerializer, LeadSerializer


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
        queryset = Company.objects.all()
        user = self.request.user
        if user.role == User.Role.SALES_REP:
            queryset = queryset.filter(owner=user)
        return queryset

    def perform_create(self, serializer):
        user = self.request.user
        if user.role == User.Role.SALES_REP:
            serializer.save(owner=user)
        else:
            serializer.save()


class LeadViewSet(viewsets.ModelViewSet):
    serializer_class = LeadSerializer
    permission_classes = [IsAuthenticated, RoleBasedAccess]
    filterset_fields = ['status', 'assigned_to']
    search_fields = ['company__name']
    ordering_fields = ['created_at']
    ordering = ['-created_at']

    def get_queryset(self):
        queryset = Lead.objects.all()
        user = self.request.user
        if user.role == User.Role.SALES_REP:
            queryset = queryset.filter(assigned_to=user)
        return queryset

    def perform_create(self, serializer):
        user = self.request.user
        if user.role == User.Role.SALES_REP or 'assigned_to' not in serializer.validated_data:
            serializer.save(assigned_to=user)
        else:
            serializer.save()
