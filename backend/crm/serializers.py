from django.db import transaction
from django.utils import timezone
from rest_framework import serializers

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
from .permissions import FULL_ACCESS_ROLES


class CompanySerializer(serializers.ModelSerializer):
    owner_username = serializers.CharField(source='owner.username', read_only=True, default=None)
    archived_by_username = serializers.CharField(source='archived_by.username', read_only=True, default=None)

    class Meta:
        model = Company
        fields = [
            'id', 'name', 'industry', 'website', 'created_at', 'owner', 'owner_username',
            'is_archived', 'archived_by', 'archived_by_username', 'archived_at', 'archive_reason',
        ]
        read_only_fields = ['created_at', 'is_archived', 'archived_by', 'archived_at', 'archive_reason']

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
        request = self.context.get('request')
        owner_changed = 'owner' in validated_data and validated_data['owner'] != instance.owner
        new_owner = validated_data.get('owner')
        with transaction.atomic():
            company = super().update(instance, validated_data)
            if owner_changed and new_owner is not None:
                company.leads.update(assigned_to=new_owner)
                company.deals.update(assigned_to=new_owner)
                for lead in company.leads.all():
                    ActivityEvent.record(
                        lead,
                        ActivityEvent.Category.ADMINISTRATIVE,
                        f'Company owner changed to {new_owner.username}; lead reassigned.',
                        actor=request.user if request else None,
                    )
        return company


class ContactSerializer(serializers.ModelSerializer):
    company_name = serializers.CharField(source='company.name', read_only=True, default=None)
    archived_by_username = serializers.CharField(source='archived_by.username', read_only=True, default=None)

    class Meta:
        model = Contact
        fields = [
            'id', 'company', 'company_name', 'name', 'email', 'phone', 'job_title',
            'is_archived', 'archived_by', 'archived_by_username', 'archived_at', 'archive_reason',
        ]
        read_only_fields = ['is_archived', 'archived_by', 'archived_at', 'archive_reason']


class LeadSerializer(serializers.ModelSerializer):
    assigned_to = serializers.PrimaryKeyRelatedField(queryset=User.objects.all(), required=False)
    assigned_to_username = serializers.CharField(source='assigned_to.username', read_only=True, default=None)
    company_name = serializers.CharField(source='company.name', read_only=True, default=None)
    contact_name = serializers.CharField(source='contact.name', read_only=True, default=None)
    interaction_count = serializers.IntegerField(read_only=True, default=0)
    # Populated via a queryset annotation (see LeadViewSet.get_queryset) that
    # matches this lead's contact to a Deal, since neither model has a direct
    # FK to the other. Falls back to these defaults where that annotation
    # isn't present (e.g. the dashboard's lead queryset).
    deal_stage = serializers.CharField(read_only=True, default=None)
    has_project = serializers.BooleanField(read_only=True, default=False)
    archived_by_username = serializers.CharField(source='archived_by.username', read_only=True, default=None)

    class Meta:
        model = Lead
        fields = [
            'id', 'name', 'company', 'company_name', 'contact', 'contact_name', 'status', 'created_at',
            'last_activity_at', 'last_internal_activity_at', 'assigned_to', 'assigned_to_username',
            'interaction_count', 'deal_stage', 'has_project',
            'is_archived', 'archived_by', 'archived_by_username', 'archived_at', 'archive_reason',
        ]
        read_only_fields = [
            'created_at', 'last_activity_at', 'last_internal_activity_at',
            'is_archived', 'archived_by', 'archived_at', 'archive_reason',
        ]

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

    def update(self, instance, validated_data):
        request = self.context.get('request')
        changes = []
        if 'name' in validated_data and validated_data['name'] != instance.name:
            changes.append('name changed')
        if 'status' in validated_data and validated_data['status'] != instance.status:
            changes.append(f"status changed to {validated_data['status']}")
        if 'contact' in validated_data and validated_data['contact'] != instance.contact:
            changes.append('contact changed')
        if 'assigned_to' in validated_data and validated_data['assigned_to'] != instance.assigned_to:
            new_assignee = validated_data['assigned_to']
            changes.append(f'assigned to {new_assignee.username}' if new_assignee else 'unassigned')

        lead = super().update(instance, validated_data)

        if changes and request:
            ActivityEvent.record(
                lead,
                ActivityEvent.Category.ADMINISTRATIVE,
                'Lead updated: ' + '; '.join(changes),
                actor=request.user,
            )
        return lead


class InteractionSerializer(serializers.ModelSerializer):
    created_by_username = serializers.CharField(source='created_by.username', read_only=True, default=None)

    class Meta:
        model = Interaction
        fields = [
            'id', 'lead', 'type', 'outcome', 'notes', 'occurred_at', 'created_by', 'created_by_username',
        ]
        read_only_fields = ['created_by']

    def validate(self, attrs):
        itype = attrs.get('type', getattr(self.instance, 'type', None))
        outcome = attrs.get('outcome', serializers.empty)
        if itype == Interaction.Type.NOTE:
            if outcome not in (serializers.empty, None):
                raise serializers.ValidationError({'outcome': 'NOTE interactions cannot have an outcome.'})
            attrs['outcome'] = None
        return attrs

    def create(self, validated_data):
        request = self.context.get('request')
        if request:
            validated_data['created_by'] = request.user
        return super().create(validated_data)


class ProjectSerializer(serializers.ModelSerializer):
    company_name = serializers.CharField(source='company.name', read_only=True, default=None)
    phase_progress = serializers.SerializerMethodField()
    overall_progress = serializers.SerializerMethodField()
    pending_approval_requests = serializers.SerializerMethodField()
    archived_by_username = serializers.CharField(source='archived_by.username', read_only=True, default=None)

    PHASE_FIELDS = ['phase_1_status', 'phase_2_status', 'phase_3_status']
    PHASE_SIGNOFF_TYPES = {
        1: ApprovalRequest.RequestType.PHASE_1_SIGNOFF,
        2: ApprovalRequest.RequestType.PHASE_2_SIGNOFF,
        3: ApprovalRequest.RequestType.PHASE_3_SIGNOFF,
    }

    class Meta:
        model = Project
        fields = [
            'id', 'lead', 'company', 'company_name', 'deal', 'current_phase',
            'phase_1_status', 'phase_2_status', 'phase_3_status',
            'maintenance', 'phase_progress', 'overall_progress', 'pending_approval_requests',
            'is_archived', 'archived_by', 'archived_by_username', 'archived_at', 'archive_reason',
            'created_at', 'updated_at',
        ]
        read_only_fields = [
            'maintenance', 'created_at', 'updated_at',
            'is_archived', 'archived_by', 'archived_at', 'archive_reason',
        ]

    @staticmethod
    def _percent(completed, total):
        return round(completed / total * 100) if total else 0

    @staticmethod
    def _applicable(requirements):
        return [r for r in requirements if r.status != PhaseRequirement.Status.NOT_APPLICABLE]

    def get_phase_progress(self, obj):
        progress = {}
        for phase in (1, 2, 3):
            applicable = self._applicable(r for r in obj.requirements.all() if r.phase == phase)
            total = len(applicable)
            completed = sum(1 for r in applicable if r.is_confirmed_complete)
            progress[phase] = {'completed': completed, 'total': total, 'percent': self._percent(completed, total)}
        return progress

    def get_overall_progress(self, obj):
        applicable = self._applicable(obj.requirements.all())
        completed = sum(1 for r in applicable if r.is_confirmed_complete)
        return self._percent(completed, len(applicable))

    def get_pending_approval_requests(self, obj):
        # Prefer the prefetch set up by ProjectViewSet.get_queryset; fall
        # back to a live query for instances that didn't go through it (e.g.
        # the object returned straight from a create()/update() call).
        pending = getattr(obj, 'pending_requests', None)
        if pending is None:
            pending = obj.approval_requests.filter(status=ApprovalRequest.Status.PENDING)
        return [r.request_type for r in pending]

    def update(self, instance, validated_data):
        request = self.context.get('request')
        phase_1_newly_complete = (
            validated_data.get('phase_1_status') == Project.PhaseStatus.COMPLETE
            and instance.phase_1_status != Project.PhaseStatus.COMPLETE
        )
        changed_phases = []

        for phase_num, field_name in enumerate(self.PHASE_FIELDS, start=1):
            if field_name not in validated_data:
                continue
            new_status = validated_data[field_name]
            if new_status == getattr(instance, field_name):
                continue
            changed_phases.append((phase_num, new_status))

            if new_status == Project.PhaseStatus.IN_PROGRESS and phase_num > 1:
                prev_field = self.PHASE_FIELDS[phase_num - 2]
                prev_effective = validated_data.get(prev_field, getattr(instance, prev_field))
                if prev_effective != Project.PhaseStatus.COMPLETE:
                    raise serializers.ValidationError({
                        field_name: f'Phase {phase_num} cannot start until phase {phase_num - 1} is complete.',
                    })

            if new_status == Project.PhaseStatus.AWAITING_APPROVAL:
                phase_requirements = self._applicable(
                    r for r in instance.requirements.all() if r.phase == phase_num
                )
                if any(not r.is_confirmed_complete for r in phase_requirements):
                    raise serializers.ValidationError({
                        field_name: f'Phase {phase_num} still has incomplete requirements.',
                    })

            if new_status == Project.PhaseStatus.COMPLETE:
                has_approval = ApprovalRequest.objects.filter(
                    project=instance,
                    request_type=self.PHASE_SIGNOFF_TYPES[phase_num],
                    status=ApprovalRequest.Status.APPROVED,
                ).exists()
                if not has_approval:
                    raise serializers.ValidationError({
                        field_name: (
                            f'Phase {phase_num} needs an approved '
                            f'{self.PHASE_SIGNOFF_TYPES[phase_num].label} request first.'
                        ),
                    })

        project = super().update(instance, validated_data)

        for phase_num, new_status in changed_phases:
            if new_status == Project.PhaseStatus.IN_PROGRESS:
                project.start_phase(phase_num)

        if request and changed_phases:
            for phase_num, new_status in changed_phases:
                ActivityEvent.record(
                    project.lead,
                    ActivityEvent.Category.PHASE,
                    f'Phase {phase_num} moved to {new_status}',
                    actor=request.user,
                )
            Lead.objects.filter(pk=project.lead_id).update(last_internal_activity_at=timezone.now())

        if phase_1_newly_complete:
            self._advance_after_phase_1_complete(project)

        if all(getattr(project, f) == Project.PhaseStatus.COMPLETE for f in self.PHASE_FIELDS):
            if not project.maintenance:
                project.maintenance = True
                project.save(update_fields=['maintenance'])

        return project

    @classmethod
    def complete_phase(cls, project, phase_num):
        # Shared by the manual "PATCH phase_N_status=COMPLETE" path (via
        # update(), once an approved signoff already exists) and by
        # ApprovalRequestSerializer approving that same signoff automatically
        # -- same completion + downstream effects either way. A no-op if the
        # phase is already complete, so approving a signoff after someone
        # already completed it manually (or vice versa) is harmless.
        field_name = cls.PHASE_FIELDS[phase_num - 1]
        if getattr(project, field_name) == Project.PhaseStatus.COMPLETE:
            return project

        setattr(project, field_name, Project.PhaseStatus.COMPLETE)
        project.save(update_fields=[field_name])

        if phase_num == 1:
            cls._advance_after_phase_1_complete(project)
        elif phase_num == 2:
            if project.phase_3_status == Project.PhaseStatus.NOT_STARTED:
                project.phase_3_status = Project.PhaseStatus.IN_PROGRESS
                project.save(update_fields=['phase_3_status'])
                project.start_phase(3)
        elif phase_num == 3 and not project.maintenance:
            project.maintenance = True
            project.save(update_fields=['maintenance'])

        return project

    @staticmethod
    def _advance_after_phase_1_complete(project):
        deal = project.deal or Deal.objects.filter(company=project.company).order_by('-id').first()
        if deal is None:
            # No Deal exists anywhere on this company -- create one rather
            # than skipping the Closed-Won transition.
            deal = Deal.objects.create(
                company=project.company,
                contact=project.lead.contact,
                stage=Deal.Stage.CLOSED_WON,
                value=None,
                assigned_to=project.lead.assigned_to,
            )
        else:
            deal.stage = Deal.Stage.CLOSED_WON
            deal.save(update_fields=['stage'])

        project.deal = deal
        phase_2_starting = project.phase_2_status == Project.PhaseStatus.NOT_STARTED
        if phase_2_starting:
            project.phase_2_status = Project.PhaseStatus.IN_PROGRESS
        project.save()
        if phase_2_starting:
            project.start_phase(2)


class PhaseRequirementSerializer(serializers.ModelSerializer):
    updated_by_username = serializers.CharField(source='updated_by.username', read_only=True, default=None)
    confirmed_by_username = serializers.CharField(source='confirmed_by.username', read_only=True, default=None)
    effective_due_date = serializers.DateField(read_only=True)
    is_overdue = serializers.BooleanField(read_only=True)
    completed_late = serializers.BooleanField(read_only=True)
    # Convenience fields for contexts (e.g. the dashboard's overdue-tasks
    # group) that display a task without also having its Project/Lead loaded.
    lead_id = serializers.IntegerField(source='project.lead_id', read_only=True)
    company_name = serializers.CharField(source='project.company.name', read_only=True, default=None)

    class Meta:
        model = PhaseRequirement
        fields = [
            'id', 'project', 'phase', 'label', 'description', 'status', 'notes',
            'due_date', 'committed_date', 'effective_due_date', 'is_overdue', 'completed_late',
            'confirmation_authority', 'client_facing', 'lead_id', 'company_name',
            'updated_by', 'updated_by_username', 'updated_at',
            'confirmed_by', 'confirmed_by_username', 'confirmed_at',
        ]
        read_only_fields = [
            'project', 'phase', 'label', 'description', 'confirmation_authority', 'client_facing',
            # due_date is calculated at phase start (see Project.start_phase)
            # -- committed_date, not due_date, is the field a rep/manager can
            # set directly.
            'due_date',
            'updated_by', 'updated_at', 'confirmed_by', 'confirmed_at',
        ]

    def validate(self, attrs):
        # confirmed_by/confirmed_at are read-only, so DRF would otherwise
        # just silently drop them from the input -- reject instead so a
        # client can't be misled into thinking a direct write took effect.
        submitted = {'confirmed_by', 'confirmed_at'} & set(self.initial_data.keys())
        if submitted:
            raise serializers.ValidationError({
                field: 'This field is set automatically and cannot be provided directly.' for field in submitted
            })
        return attrs

    def update(self, instance, validated_data):
        request = self.context.get('request')
        user = request.user if request else None
        new_status = validated_data.get('status', instance.status)
        status_changing = 'status' in validated_data and validated_data['status'] != instance.status
        committed_date_changing = (
            'committed_date' in validated_data and validated_data['committed_date'] != instance.committed_date
        )
        old_committed_date = instance.committed_date

        if 'status' in validated_data or 'notes' in validated_data or 'committed_date' in validated_data:
            validated_data['updated_by'] = user

        newly_confirmed = False
        if new_status == PhaseRequirement.Status.COMPLETED:
            if instance.status != PhaseRequirement.Status.COMPLETED:
                validated_data['completed_at'] = timezone.now()
            if (
                instance.confirmation_authority == PhaseRequirement.ConfirmationAuthority.MANAGER
                and user is not None
                and user.role in FULL_ACCESS_ROLES
            ):
                validated_data['confirmed_by'] = user
                validated_data['confirmed_at'] = timezone.now()
                newly_confirmed = instance.confirmed_by_id is None
        else:
            validated_data['confirmed_by'] = None
            validated_data['confirmed_at'] = None
            validated_data['completed_at'] = None

        requirement = super().update(instance, validated_data)

        if committed_date_changing and user is not None:
            ActivityEvent.record(
                requirement.project.lead,
                ActivityEvent.Category.ADMINISTRATIVE,
                (
                    f'Committed date for "{requirement.label}" changed from '
                    f'{old_committed_date or "none"} to {requirement.committed_date or "none"}'
                ),
                actor=user,
            )

        if status_changing and user is not None:
            description = f'Task "{requirement.label}" marked {requirement.get_status_display()}'
            if newly_confirmed:
                description += ' and confirmed'
            ActivityEvent.record(requirement.project.lead, ActivityEvent.Category.PHASE, description, actor=user)

            lead_id = requirement.project.lead_id
            if requirement.client_facing and new_status == PhaseRequirement.Status.COMPLETED:
                # A client-facing task completing is treated exactly like a
                # RESPONDED interaction -- it's real confirmed client contact,
                # not just internal progress, so it (and only it) flips HOT.
                Lead.objects.filter(pk=lead_id).update(last_activity_at=timezone.now(), status=Lead.Status.HOT)
            else:
                Lead.objects.filter(pk=lead_id).update(last_internal_activity_at=timezone.now())

        return requirement


class RequirementTemplateSerializer(serializers.ModelSerializer):
    class Meta:
        model = RequirementTemplate
        fields = [
            'id', 'phase', 'label', 'description', 'order',
            'confirmation_authority', 'client_facing', 'default_duration_days', 'is_active',
        ]


class ApprovalRequestSerializer(serializers.ModelSerializer):
    requested_by_username = serializers.CharField(source='requested_by.username', read_only=True, default=None)
    decided_by_username = serializers.CharField(source='decided_by.username', read_only=True, default=None)
    lead_name = serializers.SerializerMethodField()
    company_name = serializers.SerializerMethodField()
    phase_number = serializers.SerializerMethodField()

    PHASE_SIGNOFF_PHASE_NUMBERS = {
        ApprovalRequest.RequestType.PHASE_1_SIGNOFF: 1,
        ApprovalRequest.RequestType.PHASE_2_SIGNOFF: 2,
        ApprovalRequest.RequestType.PHASE_3_SIGNOFF: 3,
    }

    class Meta:
        model = ApprovalRequest
        fields = [
            'id', 'request_type', 'lead', 'project', 'status', 'reason', 'decision_note',
            'requested_by', 'requested_by_username', 'decided_by', 'decided_by_username',
            'lead_name', 'company_name', 'phase_number',
            'created_at', 'decided_at',
        ]
        read_only_fields = ['requested_by', 'decided_by', 'created_at', 'decided_at']

    def _resolve_lead(self, obj):
        if obj.lead is not None:
            return obj.lead
        if obj.project is not None:
            return obj.project.lead
        return None

    def get_lead_name(self, obj):
        lead = self._resolve_lead(obj)
        return lead.name if lead is not None else None

    def get_company_name(self, obj):
        if obj.lead is not None:
            return obj.lead.company.name
        if obj.project is not None:
            return obj.project.company.name
        return None

    def get_phase_number(self, obj):
        if obj.request_type.startswith('PHASE_') and obj.request_type.endswith('_SIGNOFF'):
            return int(obj.request_type.split('_')[1])
        return None

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        if self.instance is not None:
            for field_name in ('request_type', 'lead', 'project', 'reason'):
                self.fields[field_name].read_only = True
        else:
            self.fields['status'].read_only = True

    def validate(self, attrs):
        if self.instance is None:
            lead, project = attrs.get('lead'), attrs.get('project')
            if bool(lead) == bool(project):
                raise serializers.ValidationError('Provide exactly one of lead or project.')
            request_type = attrs.get('request_type')
            if request_type == ApprovalRequest.RequestType.ARCHIVE_LEAD and lead is None:
                raise serializers.ValidationError({'lead': 'ARCHIVE_LEAD requests must target a lead.'})
            if request_type != ApprovalRequest.RequestType.ARCHIVE_LEAD and project is None:
                raise serializers.ValidationError({'project': 'Phase signoff requests must target a project.'})
            # No manual duplicate-pending check here: ModelSerializer already
            # derives a condition-aware UniqueTogetherValidator from the
            # model's UniqueConstraint (see ApprovalRequest.Meta), which runs
            # before this method and raises first with the same message.
        else:
            new_status = attrs.get('status')
            if new_status and new_status == ApprovalRequest.Status.PENDING:
                raise serializers.ValidationError({'status': 'Status can only be changed to APPROVED or REJECTED.'})
        return attrs

    def create(self, validated_data):
        request = self.context['request']
        validated_data['requested_by'] = request.user
        approval = super().create(validated_data)
        if approval.request_type == ApprovalRequest.RequestType.ARCHIVE_LEAD and approval.lead is not None:
            ActivityEvent.record(
                approval.lead,
                ActivityEvent.Category.DESTRUCTIVE,
                f'Archive requested: {approval.reason}' if approval.reason else 'Archive requested',
                actor=request.user,
            )
        return approval

    def update(self, instance, validated_data):
        new_status = validated_data.get('status')
        if new_status and new_status != instance.status:
            request = self.context['request']
            with transaction.atomic():
                instance.decided_by = request.user
                instance.decided_at = timezone.now()
                if new_status == ApprovalRequest.Status.APPROVED:
                    self._apply_approval_side_effect(instance, request)
                elif new_status == ApprovalRequest.Status.REJECTED:
                    self._apply_rejection_side_effect(instance)
                return super().update(instance, validated_data)
        return super().update(instance, validated_data)

    @classmethod
    def _apply_approval_side_effect(cls, instance, request):
        if instance.request_type == ApprovalRequest.RequestType.ARCHIVE_LEAD:
            lead = instance.lead
            if lead is None or lead.is_archived:
                return
            lead.is_archived = True
            lead.archived_by = request.user
            lead.archived_at = timezone.now()
            lead.archive_reason = instance.reason or 'Archived via an approved archive request.'
            lead.save()
            ActivityEvent.record(
                lead,
                ActivityEvent.Category.DESTRUCTIVE,
                f'Lead archived: {lead.archive_reason}',
                actor=request.user,
            )
            return

        # Phase sign-off requests: approving one completes that phase on the
        # linked Project (and its downstream effects), the same way approving
        # an ARCHIVE_LEAD request archives the lead above.
        phase_num = cls.PHASE_SIGNOFF_PHASE_NUMBERS.get(instance.request_type)
        if phase_num is None or instance.project is None:
            return
        ProjectSerializer.complete_phase(instance.project, phase_num)

    @classmethod
    def _apply_rejection_side_effect(cls, instance):
        phase_num = cls.PHASE_SIGNOFF_PHASE_NUMBERS.get(instance.request_type)
        if phase_num is None or instance.project is None:
            return
        project = instance.project
        field_name = ProjectSerializer.PHASE_FIELDS[phase_num - 1]
        if getattr(project, field_name) == Project.PhaseStatus.AWAITING_APPROVAL:
            setattr(project, field_name, Project.PhaseStatus.IN_PROGRESS)
            project.save(update_fields=[field_name])


class ActivityEventSerializer(serializers.ModelSerializer):
    actor_username = serializers.CharField(source='actor.username', read_only=True, default=None)

    class Meta:
        model = ActivityEvent
        fields = ['id', 'category', 'description', 'actor', 'actor_username', 'occurred_at']


class UserSummarySerializer(serializers.ModelSerializer):
    class Meta:
        model = User
        fields = ['id', 'username', 'role']


class SystemSettingsSerializer(serializers.ModelSerializer):
    class Meta:
        model = SystemSettings
        fields = ['id', 'cold_lead_days', 'updated_at']
        read_only_fields = ['id', 'updated_at']
