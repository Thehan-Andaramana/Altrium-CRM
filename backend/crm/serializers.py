from rest_framework import serializers

from .models import Company, Lead, User


class CompanySerializer(serializers.ModelSerializer):
    class Meta:
        model = Company
        fields = ['id', 'name', 'industry', 'website', 'created_at', 'owner']
        read_only_fields = ['created_at']


class LeadSerializer(serializers.ModelSerializer):
    assigned_to = serializers.PrimaryKeyRelatedField(queryset=User.objects.all(), required=False)

    class Meta:
        model = Lead
        fields = ['id', 'company', 'contact', 'status', 'created_at', 'last_activity_at', 'assigned_to']
        read_only_fields = ['created_at', 'last_activity_at']
