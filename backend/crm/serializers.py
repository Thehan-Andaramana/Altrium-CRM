from django.db import transaction
from rest_framework import serializers

from .models import Company, Interaction, Lead, SystemSettings, User
from .permissions import FULL_ACCESS_ROLES


class CompanySerializer(serializers.ModelSerializer):
    owner_username = serializers.CharField(source='owner.username', read_only=True, default=None)

    class Meta:
        model = Company
        fields = ['id', 'name', 'industry', 'website', 'created_at', 'owner', 'owner_username']
        read_only_fields = ['created_at']

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        request = self.context.get('request')
        if request and request.user.role not in FULL_ACCESS_ROLES:
            self.fields['owner'].read_only = True

    def create(self, validated_data):
        request = self.context.get('request')
        if request and request.user.role == User.Role.SALES_REP:
            validated_data['owner'] = request.user
        return super().create(validated_data)

    def update(self, instance, validated_data):
        owner_changed = 'owner' in validated_data and validated_data['owner'] != instance.owner
        new_owner = validated_data.get('owner')
        with transaction.atomic():
            company = super().update(instance, validated_data)
            if owner_changed and new_owner is not None:
                company.leads.update(assigned_to=new_owner)
                company.deals.update(assigned_to=new_owner)
        return company


class LeadSerializer(serializers.ModelSerializer):
    assigned_to = serializers.PrimaryKeyRelatedField(queryset=User.objects.all(), required=False)
    assigned_to_username = serializers.CharField(source='assigned_to.username', read_only=True, default=None)
    company_name = serializers.CharField(source='company.name', read_only=True, default=None)
    contact_name = serializers.CharField(source='contact.name', read_only=True, default=None)
    interaction_count = serializers.IntegerField(read_only=True, default=0)

    class Meta:
        model = Lead
        fields = [
            'id', 'company', 'company_name', 'contact', 'contact_name', 'status', 'created_at',
            'last_activity_at', 'assigned_to', 'assigned_to_username', 'interaction_count',
        ]
        read_only_fields = ['created_at', 'last_activity_at']

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        request = self.context.get('request')
        if request and request.user.role not in FULL_ACCESS_ROLES:
            self.fields['assigned_to'].read_only = True

    def create(self, validated_data):
        request = self.context.get('request')
        if request:
            if request.user.role == User.Role.SALES_REP:
                validated_data['assigned_to'] = request.user
            elif 'assigned_to' not in validated_data:
                validated_data['assigned_to'] = request.user
        return super().create(validated_data)


class InteractionSerializer(serializers.ModelSerializer):
    created_by_username = serializers.CharField(source='created_by.username', read_only=True, default=None)

    class Meta:
        model = Interaction
        fields = ['id', 'lead', 'type', 'notes', 'occurred_at', 'created_by', 'created_by_username']
        read_only_fields = ['created_by']

    def create(self, validated_data):
        request = self.context.get('request')
        if request:
            validated_data['created_by'] = request.user
        return super().create(validated_data)


class UserSummarySerializer(serializers.ModelSerializer):
    class Meta:
        model = User
        fields = ['id', 'username', 'role']


class SystemSettingsSerializer(serializers.ModelSerializer):
    class Meta:
        model = SystemSettings
        fields = ['id', 'cold_lead_days', 'updated_at']
        read_only_fields = ['id', 'updated_at']
