"""
URL configuration for config project.

The `urlpatterns` list routes URLs to views. For more information please see:
    https://docs.djangoproject.com/en/6.1/topics/http/urls/
Examples:
Function views
    1. Add an import:  from my_app import views
    2. Add a URL to urlpatterns:  path('', views.home, name='home')
Class-based views
    1. Add an import:  from other_app.views import Home
    2. Add a URL to urlpatterns:  path('', Home.as_view(), name='home')
Including another URLconf
    1. Import the include() function: from django.urls import include, path
    2. Add a URL to urlpatterns:  path('blog/', include('blog.urls'))
"""
from django.conf import settings
from django.conf.urls.static import static
from django.contrib import admin
from django.urls import include, path
from drf_spectacular.views import SpectacularAPIView, SpectacularSwaggerView
from rest_framework.routers import DefaultRouter

from crm.reports import ReportsView
from crm.views import (
    ApprovalRequestViewSet,
    CalendarView,
    CompanyViewSet,
    ContactViewSet,
    DashboardView,
    InteractionViewSet,
    LeadViewSet,
    MentionViewSet,
    PhaseRequirementViewSet,
    ProjectViewSet,
    RequirementTemplateViewSet,
    SidebarBadgeView,
    SystemSettingsView,
    TaskAttachmentViewSet,
    UserViewSet,
)

router = DefaultRouter()
router.register('companies', CompanyViewSet, basename='company')
router.register('contacts', ContactViewSet, basename='contact')
router.register('leads', LeadViewSet, basename='lead')
router.register('interactions', InteractionViewSet, basename='interaction')
router.register('users', UserViewSet, basename='user')
router.register('projects', ProjectViewSet, basename='project')
router.register('approvals', ApprovalRequestViewSet, basename='approvalrequest')
router.register('requirements', PhaseRequirementViewSet, basename='phaserequirement')
router.register('attachments', TaskAttachmentViewSet, basename='taskattachment')
router.register('requirement-templates', RequirementTemplateViewSet, basename='requirementtemplate')
router.register('notifications', MentionViewSet, basename='notification')

urlpatterns = [
    path('admin/', admin.site.urls),
    path('api/auth/', include('crm.urls')),
    path('api/settings/', SystemSettingsView.as_view(), name='system-settings'),
    path('api/dashboard/', DashboardView.as_view(), name='dashboard'),
    path('api/calendar/', CalendarView.as_view(), name='calendar'),
    path('api/badges/', SidebarBadgeView.as_view(), name='sidebar-badges'),
    path('api/reports/', ReportsView.as_view(), name='reports'),
    path('api/', include(router.urls)),
    path('api/schema/', SpectacularAPIView.as_view(), name='schema'),
    path(
        'api/docs/',
        SpectacularSwaggerView.as_view(url_name='schema'),
        name='swagger-ui',
    ),
]

if settings.DEBUG:
    urlpatterns += static(settings.MEDIA_URL, document_root=settings.MEDIA_ROOT)
