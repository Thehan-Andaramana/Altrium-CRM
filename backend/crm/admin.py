from django.contrib import admin
from django.contrib.auth.admin import UserAdmin

from .models import Company, Contact, Deal, Lead, User


@admin.register(User)
class CRMUserAdmin(UserAdmin):
    list_display = UserAdmin.list_display + ('role',)
    list_filter = UserAdmin.list_filter + ('role',)
    fieldsets = UserAdmin.fieldsets + (
        ('Role', {'fields': ('role',)}),
    )


@admin.register(Company)
class CompanyAdmin(admin.ModelAdmin):
    list_display = ('name', 'industry', 'website', 'owner', 'created_at')
    list_filter = ('industry', 'created_at')
    search_fields = ('name', 'industry', 'website')


@admin.register(Contact)
class ContactAdmin(admin.ModelAdmin):
    list_display = ('name', 'company', 'email', 'phone', 'job_title')
    list_filter = ('company',)
    search_fields = ('name', 'email', 'phone', 'job_title')


@admin.register(Lead)
class LeadAdmin(admin.ModelAdmin):
    list_display = ('company', 'contact', 'status', 'assigned_to', 'created_at', 'last_activity_at')
    list_filter = ('status', 'assigned_to')
    search_fields = ('company__name', 'contact__name')


@admin.register(Deal)
class DealAdmin(admin.ModelAdmin):
    list_display = ('company', 'contact', 'stage', 'value', 'assigned_to')
    list_filter = ('stage', 'assigned_to')
    search_fields = ('company__name', 'contact__name')
