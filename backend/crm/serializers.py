from datetime import timedelta
from decimal import Decimal, InvalidOperation

from django.db import transaction
from django.utils import timezone
from rest_framework import serializers

from .models import (
    ActivityEvent,
    ApprovalRequest,
    Company,
    Contact,
    Deal,
    ExecutionStatusEvent,
    Interaction,
    Lead,
    Mention,
    PhaseRequirement,
    Project,
    RequirementTemplate,
    SystemSettings,
    TASK_REFERENCE_PATTERN,
    TaskAttachment,
    TaskFormField,
    TaskFormResponse,
    User,
)
from .permissions import FULL_ACCESS_ROLES, MANAGER_ROLES


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
    # Not a model field -- only used to build the ActivityEvent description
    # when a management role changes status directly (see update() below).
    status_change_reason = serializers.CharField(write_only=True, required=False, allow_blank=True)

    class Meta:
        model = Lead
        fields = [
            'id', 'name', 'company', 'company_name', 'contact', 'contact_name', 'status', 'status_change_reason',
            'created_at',
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

    def validate(self, attrs):
        request = self.context.get('request')
        role = request.user.role if request else None

        # MANAGER_ROLES, not FULL_ACCESS_ROLES: the intent is manager-only,
        # and SYSTEM_ADMIN is deliberately excluded from lead management
        # (see ArchivableOwnedResourcePermission) -- stating the rule the
        # same way here means it's no longer only true by accident of
        # SYSTEM_ADMIN's PATCH being blocked upstream at the permission layer.
        if role is not None and role not in MANAGER_ROLES and 'status' in attrs:
            raise serializers.ValidationError({
                'status': 'Only management roles can change a lead\'s status.',
            })

        if (
            self.instance is not None
            and 'status' in attrs
            and attrs['status'] != self.instance.status
            and not (attrs.get('status_change_reason') or '').strip()
        ):
            raise serializers.ValidationError({
                'status_change_reason': 'A reason is required when changing a lead\'s status.',
            })

        if role == User.Role.SALES_REP:
            company = attrs.get('company') or (self.instance.company if self.instance else None)
            if company is not None:
                user = request.user
                connected = (
                    company.owner_id == user.id
                    or Lead.objects.filter(company=company, assigned_to=user).exists()
                )
                if not connected:
                    raise serializers.ValidationError({
                        'company': (
                            'You can only create or update a lead for a company you own '
                            'or already have an assigned lead on.'
                        ),
                    })

        return attrs

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
        status_reason = validated_data.pop('status_change_reason', '')
        if 'name' in validated_data and validated_data['name'] != instance.name:
            changes.append('name changed')
        if 'status' in validated_data and validated_data['status'] != instance.status:
            status_change = f"status changed to {validated_data['status']}"
            if status_reason:
                status_change += f' ({status_reason})'
            changes.append(status_change)
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
    # The exact set of usernames Interaction.save() actually turned into a
    # Mention (i.e. known, non-self) -- lets the timeline highlight only
    # real mentions in `notes` rather than re-parsing (and mis-highlighting
    # unknown-username or self-mention "@word" text) on the client.
    mentioned_usernames = serializers.SerializerMethodField()
    # Every "#<id>" in notes that resolves to a real task on this
    # interaction's own project -- unlike mentioned_usernames, this is NOT
    # sourced from Mention rows: a task reference renders as a link
    # regardless of who wrote it or whether it happened to notify anyone
    # (see Interaction._create_task_mentions, which is the notify-or-not
    # decision; this field is purely "what's linkable").
    referenced_tasks = serializers.SerializerMethodField()

    class Meta:
        model = Interaction
        fields = [
            'id', 'lead', 'type', 'outcome', 'notes', 'occurred_at', 'created_by', 'created_by_username',
            'mentioned_usernames', 'referenced_tasks',
        ]
        read_only_fields = ['created_by']

    def get_mentioned_usernames(self, obj):
        # Filtering in Python (not .filter() on the manager) so this can use
        # the ViewSet's mentions__user prefetch instead of a fresh query.
        return [m.user.username for m in obj.mentions.all() if m.task_id is None]

    def get_referenced_tasks(self, obj):
        task_ids = {int(match) for match in TASK_REFERENCE_PATTERN.findall(obj.notes or '')}
        if not task_ids:
            return []
        # Lead.project is a reverse OneToOne descriptor, not a field -- no
        # project_id shortcut, so this fetches the Project itself.
        tasks = PhaseRequirement.objects.filter(pk__in=task_ids, project=obj.lead.project)
        return [{'id': task.id, 'label': task.label} for task in tasks]

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


class MentionSerializer(serializers.ModelSerializer):
    created_by_username = serializers.CharField(source='created_by.username', read_only=True, default=None)
    lead_id = serializers.IntegerField(source='interaction.lead_id', read_only=True)
    lead_name = serializers.CharField(source='interaction.lead.name', read_only=True)
    note_snippet = serializers.SerializerMethodField()
    # Only set when this notification exists because a task was tagged
    # ("#42"), not a plain "@username" mention -- lets the notification
    # centre say "tagged your task X" instead of the generic note snippet.
    task_label = serializers.CharField(source='task.label', read_only=True, default=None)

    SNIPPET_LENGTH = 140

    class Meta:
        model = Mention
        fields = [
            'id', 'interaction', 'lead_id', 'lead_name', 'note_snippet',
            'task', 'task_label',
            'created_by', 'created_by_username', 'created_at', 'read_at',
        ]
        # Every field is read-only -- a Mention is only ever created as a
        # side effect of Interaction.save(), and the one thing a client can
        # actually change (read_at) is set by MentionViewSet.update, not by
        # whatever value the client happens to PATCH in.
        read_only_fields = fields

    def get_note_snippet(self, obj):
        notes = obj.interaction.notes or ''
        if len(notes) <= self.SNIPPET_LENGTH:
            return notes
        return notes[:self.SNIPPET_LENGTH].rstrip() + '…'


class ProjectSerializer(serializers.ModelSerializer):
    company_name = serializers.CharField(source='company.name', read_only=True, default=None)
    project_manager_username = serializers.CharField(source='project_manager.username', read_only=True, default=None)
    # The board draws a card per project and needs the lead's own identity on
    # it -- name, temperature and who carries it -- without a second request
    # per card.
    lead_name = serializers.CharField(source='lead.name', read_only=True, default=None)
    lead_status = serializers.CharField(source='lead.status', read_only=True, default=None)
    assigned_to_username = serializers.CharField(
        source='lead.assigned_to.username', read_only=True, default=None,
    )
    overdue_task_count = serializers.SerializerMethodField()
    phase_progress = serializers.SerializerMethodField()
    overall_progress = serializers.SerializerMethodField()
    pending_approval_requests = serializers.SerializerMethodField()
    archived_by_username = serializers.CharField(source='archived_by.username', read_only=True, default=None)

    PHASE_FIELDS = ['phase_1_status', 'phase_2_status', 'phase_3_status', 'phase_4_status']
    PHASE_SIGNOFF_TYPES = {
        1: ApprovalRequest.RequestType.PHASE_1_SIGNOFF,
        2: ApprovalRequest.RequestType.PHASE_2_SIGNOFF,
        # Phase 3's request is raised automatically (see update() below) when
        # its execution status reaches Completed, rather than by a manual
        # "Request sign-off" action like 1/2/4 -- but completion itself goes
        # through the exact same approved-signoff gate once requested.
        3: ApprovalRequest.RequestType.PHASE_3_SIGNOFF,
        4: ApprovalRequest.RequestType.PHASE_4_SIGNOFF,
    }

    class Meta:
        model = Project
        fields = [
            'id', 'lead', 'lead_name', 'lead_status', 'assigned_to_username',
            'company', 'company_name', 'deal', 'current_phase',
            'project_manager', 'project_manager_username',
            'phase_1_status', 'phase_2_status', 'phase_3_status', 'phase_4_status', 'phase_3_execution_status',
            'proposed_budget', 'currency', 'notes', 'board_order', 'overdue_task_count',
            'maintenance', 'phase_progress', 'overall_progress', 'pending_approval_requests',
            'is_archived', 'archived_by', 'archived_by_username', 'archived_at', 'archive_reason',
            'created_at', 'updated_at',
        ]
        read_only_fields = [
            'maintenance', 'created_at', 'updated_at',
            'is_archived', 'archived_by', 'archived_at', 'archive_reason',
        ]

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        request = self.context.get('request')
        if request and request.user.role not in MANAGER_ROLES:
            self.fields['project_manager'].read_only = True
        if request:
            user = request.user
            # self.instance is the whole queryset (not a single Project) for
            # the child serializer DRF builds when many=True (a list view) --
            # getattr rather than direct attribute access so that case just
            # falls through to "not the managing PM" instead of raising.
            is_managing_pm = (
                user.role == User.Role.PROJECT_MANAGER
                and getattr(self.instance, 'project_manager_id', None) == user.id
            )
            if user.role not in MANAGER_ROLES and not is_managing_pm:
                self.fields['proposed_budget'].read_only = True
                self.fields['currency'].read_only = True

    @staticmethod
    def _percent(completed, total):
        return round(completed / total * 100) if total else 0

    @staticmethod
    def _applicable(requirements):
        return [r for r in requirements if r.status != PhaseRequirement.Status.NOT_APPLICABLE]

    def get_phase_progress(self, obj):
        progress = {}
        for phase in (1, 2, 3, 4):
            applicable = self._applicable(r for r in obj.requirements.all() if r.phase == phase)
            total = len(applicable)
            completed = sum(1 for r in applicable if r.is_confirmed_complete)
            progress[phase] = {'completed': completed, 'total': total, 'percent': self._percent(completed, total)}
        return progress

    def get_overdue_task_count(self, obj):
        # is_overdue weighs confirmation state as well as dates, so it isn't
        # a single DB column -- counted in Python off the same prefetched
        # requirements every other method here uses.
        return sum(1 for r in obj.requirements.all() if r.is_overdue)

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
        changed_phases = []
        execution_status_changing = (
            'phase_3_execution_status' in validated_data
            and validated_data['phase_3_execution_status'] != instance.phase_3_execution_status
        )
        old_execution_status = instance.phase_3_execution_status
        new_execution_status = validated_data.get('phase_3_execution_status', instance.phase_3_execution_status)

        if execution_status_changing:
            if instance.phase_3_status == Project.PhaseStatus.COMPLETE:
                # Locked once Phase 3 is actually done -- there's nothing left
                # for the execution status to track at that point. Backward
                # moves (e.g. Review -> Building) are otherwise unrestricted
                # right up until completion, including while a sign-off is
                # already pending.
                raise serializers.ValidationError({
                    'phase_3_execution_status': 'Phase 3 is already complete -- its execution status is locked.',
                })
            if (
                new_execution_status == Project.ExecutionStatus.COMPLETED
                and instance.phase_3_status == Project.PhaseStatus.IN_PROGRESS
            ):
                phase_3_requirements = self._applicable(
                    r for r in instance.requirements.all() if r.phase == 3
                )
                if any(not r.is_confirmed_complete for r in phase_3_requirements):
                    raise serializers.ValidationError({
                        'phase_3_execution_status': 'Phase 3 still has incomplete requirements.',
                    })

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

            if new_status == Project.PhaseStatus.COMPLETE and phase_num in self.PHASE_SIGNOFF_TYPES:
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
            elif new_status == Project.PhaseStatus.COMPLETE:
                # Mirrors what complete_phase() does after marking a phase
                # complete via an approved signoff -- a phase completed
                # straight through this direct PATCH (as every phase can be,
                # once its approval exists) needs the same downstream
                # advancement, not just the ones that went through
                # ApprovalRequestSerializer's approval side effect.
                self._advance_after_phase_complete(project, phase_num)

        if request and changed_phases:
            for phase_num, new_status in changed_phases:
                ActivityEvent.record(
                    project.lead,
                    ActivityEvent.Category.PHASE,
                    f'Phase {phase_num} moved to {new_status}',
                    actor=request.user,
                )
            Lead.objects.filter(pk=project.lead_id).update(last_internal_activity_at=timezone.now())

        if execution_status_changing and request:
            ExecutionStatusEvent.objects.create(
                project=project,
                from_status=old_execution_status,
                to_status=project.phase_3_execution_status,
                changed_by=request.user,
            )
            if (
                new_execution_status == Project.ExecutionStatus.COMPLETED
                and project.phase_3_status == Project.PhaseStatus.IN_PROGRESS
            ):
                # Phase 3's sign-off is raised automatically here rather than
                # by a manual "Request sign-off" action like 1/2/4 -- the PM
                # marking execution Completed *is* the request.
                project.phase_3_status = Project.PhaseStatus.AWAITING_APPROVAL
                project.save(update_fields=['phase_3_status'])
                ApprovalRequest.objects.create(
                    project=project,
                    request_type=ApprovalRequest.RequestType.PHASE_3_SIGNOFF,
                    requested_by=request.user,
                )
                ActivityEvent.record(
                    project.lead,
                    ActivityEvent.Category.PHASE,
                    f'Phase 3 moved to {Project.PhaseStatus.AWAITING_APPROVAL}',
                    actor=request.user,
                )
                Lead.objects.filter(pk=project.lead_id).update(last_internal_activity_at=timezone.now())

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
        cls._advance_after_phase_complete(project, phase_num)
        return project

    @classmethod
    def _advance_after_phase_complete(cls, project, phase_num):
        # Called both from complete_phase() (the approval path) and directly
        # from update() (a phase PATCHed straight to COMPLETE) -- whichever
        # path completed the phase, the downstream effect is the same.
        if phase_num == 1:
            cls._advance_after_phase_1_complete(project)
        elif phase_num == 2:
            if project.phase_3_status == Project.PhaseStatus.NOT_STARTED:
                project.phase_3_status = Project.PhaseStatus.IN_PROGRESS
                project.save(update_fields=['phase_3_status'])
                project.start_phase(3)
        elif phase_num == 3:
            if project.phase_4_status == Project.PhaseStatus.NOT_STARTED:
                project.phase_4_status = Project.PhaseStatus.IN_PROGRESS
                project.save(update_fields=['phase_4_status'])
                project.start_phase(4)
        elif phase_num == 4 and not project.maintenance:
            project.maintenance = True
            project.save(update_fields=['maintenance'])

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


class TaskFormFieldSerializer(serializers.ModelSerializer):
    class Meta:
        model = TaskFormField
        fields = ['id', 'label', 'field_type', 'options', 'required', 'order', 'help_text']
        read_only_fields = ['id']

    def validate(self, attrs):
        field_type = attrs.get('field_type', getattr(self.instance, 'field_type', None))
        options = attrs.get('options', getattr(self.instance, 'options', None))
        if field_type == TaskFormField.FieldType.SELECT and not options:
            raise serializers.ValidationError({'options': 'SELECT fields need at least one option.'})
        return attrs


class TemplateFormFieldSerializer(TaskFormFieldSerializer):
    # Unlike TaskFormFieldSerializer (id read-only -- used where a field is
    # only ever created once, at task-creation time), id is writable here:
    # RequirementTemplateSerializer._sync_form_fields matches a submitted
    # field back to an existing row by id to update it in place, rather than
    # treating every save as delete-everything-and-recreate.
    id = serializers.IntegerField(required=False)


class TaskFormResponseSerializer(serializers.ModelSerializer):
    answered_by_username = serializers.CharField(source='answered_by.username', read_only=True, default=None)

    class Meta:
        model = TaskFormResponse
        fields = ['id', 'field', 'value', 'answered_by', 'answered_by_username', 'answered_at']
        read_only_fields = ['answered_by', 'answered_at']


class PhaseRequirementSerializer(serializers.ModelSerializer):
    updated_by_username = serializers.CharField(source='updated_by.username', read_only=True, default=None)
    confirmed_by_username = serializers.CharField(source='confirmed_by.username', read_only=True, default=None)
    created_by_username = serializers.CharField(source='created_by.username', read_only=True, default=None)
    effective_due_date = serializers.DateField(read_only=True)
    is_overdue = serializers.BooleanField(read_only=True)
    completed_late = serializers.BooleanField(read_only=True)
    # Convenience fields for contexts (e.g. the dashboard's overdue-tasks
    # group) that display a task without also having its Project/Lead loaded.
    lead_id = serializers.IntegerField(source='project.lead_id', read_only=True)
    company_name = serializers.CharField(source='project.company.name', read_only=True, default=None)
    # Field *definitions* (by reference -- template-owned or this task's own
    # custom ones, see PhaseRequirement.form_fields) and this task's saved
    # *answers*, both embedded so the frontend never needs a second call to
    # render the form. Neither is writable here: definitions only ever come
    # from a template or from `custom_fields` at creation (below); answers
    # are only ever written through PhaseRequirementViewSet.answers.
    form_fields = TaskFormFieldSerializer(many=True, read_only=True)
    form_responses = TaskFormResponseSerializer(many=True, read_only=True)
    # Write-only: only meaningful (and only ever used) when creating a
    # custom task -- defines its fields in the same request, since a custom
    # task has no template to attach them to afterwards.
    custom_fields = TaskFormFieldSerializer(many=True, write_only=True, required=False)

    # Fields only writable at creation -- read-only again once the task
    # exists, toggled in __init__ below rather than a static Meta list, since
    # POST needs them and PATCH (template-derived or custom) never should.
    CREATE_ONLY_FIELDS = (
        'project', 'phase', 'label', 'description', 'confirmation_authority', 'client_facing', 'due_date',
    )

    class Meta:
        model = PhaseRequirement
        fields = [
            'id', 'project', 'phase', 'label', 'description', 'status', 'notes',
            'due_date', 'committed_date', 'effective_due_date', 'is_overdue', 'completed_late',
            'confirmation_authority', 'client_facing', 'is_custom', 'lead_id', 'company_name',
            'form_fields', 'form_responses', 'custom_fields',
            'updated_by', 'updated_by_username', 'updated_at',
            'confirmed_by', 'confirmed_by_username', 'confirmed_at',
            'created_by', 'created_by_username',
        ]
        read_only_fields = [
            'is_custom', 'updated_by', 'updated_at', 'confirmed_by', 'confirmed_at', 'created_by',
        ]

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        if self.instance is not None:
            for field_name in self.CREATE_ONLY_FIELDS:
                self.fields[field_name].read_only = True

    # Who may move a task INTO Completed is purely a function of its phase,
    # not its confirmation_authority (that governs a separate, later
    # confirmation step -- see update()). Phase 1/4 are the assigned rep's;
    # phase 2/3 are the assigned PM's -- a PM can't complete a rep's task and
    # a rep can't complete a PM's, and no management role can complete any
    # task at all (they read, confirm, and edit metadata, never complete).
    # The phase->role mapping and "who is that, concretely" resolution live
    # on PhaseRequirement itself (COMPLETION_ROLE_BY_PHASE/responsible_user)
    # since Interaction._create_task_mentions needs the exact same rule to
    # decide who a tagged task notifies.
    @classmethod
    def _user_can_complete(cls, instance, user):
        if user is None:
            return False
        required_role = PhaseRequirement.COMPLETION_ROLE_BY_PHASE.get(instance.phase)
        if user.role != required_role:
            return False
        responsible = instance.responsible_user
        return responsible is not None and responsible.id == user.id

    @staticmethod
    def _completion_denied_message(instance):
        if instance.phase in (1, 4):
            return 'Only the sales rep assigned to this lead can mark this task complete.'
        return 'Only the project manager assigned to this project can mark this task complete.'

    def validate(self, attrs):
        # confirmed_by/confirmed_at/is_custom/created_by are read-only, so
        # DRF would otherwise just silently drop them from the input --
        # reject instead so a client can't be misled into thinking a direct
        # write took effect.
        submitted = {'confirmed_by', 'confirmed_at', 'is_custom', 'created_by'} & set(self.initial_data.keys())
        if submitted:
            raise serializers.ValidationError({
                field: 'This field is set automatically and cannot be provided directly.' for field in submitted
            })

        if self.instance is not None and attrs.get('status') == PhaseRequirement.Status.COMPLETED:
            newly_completing = self.instance.status != PhaseRequirement.Status.COMPLETED
            if newly_completing:
                # A resend of the same already-COMPLETED value is a
                # confirmation attempt (see update()), not a completion --
                # this gate only applies to an actual transition into it.
                request = self.context.get('request')
                user = request.user if request else None
                if not self._user_can_complete(self.instance, user):
                    raise serializers.ValidationError({'status': self._completion_denied_message(self.instance)})

            # A task with required fields can't complete until every one of
            # them has a saved (non-blank) answer -- checked against
            # whatever is already saved, since answers are written through a
            # separate endpoint (PhaseRequirementViewSet.answers), not this
            # PATCH.
            required_fields = [f for f in self.instance.form_fields if f.required]
            if required_fields:
                answered_field_ids = set(
                    self.instance.form_responses.exclude(value='').values_list('field_id', flat=True),
                )
                missing = [f.label for f in required_fields if f.id not in answered_field_ids]
                if missing:
                    raise serializers.ValidationError({
                        'status': f'Missing required fields: {", ".join(missing)}.',
                    })
        return attrs

    def create(self, validated_data):
        # Every task created through this endpoint is by definition custom --
        # the only non-custom (template-derived) rows come from Project.save()
        # bulk-creating them directly, which never goes through this serializer.
        request = self.context.get('request')
        user = request.user if request else None
        custom_fields = validated_data.pop('custom_fields', [])
        validated_data['is_custom'] = True
        validated_data['created_by'] = user
        validated_data['updated_by'] = user
        requirement = super().create(validated_data)
        for field_data in custom_fields:
            TaskFormField.objects.create(requirement=requirement, **field_data)
        if user is not None:
            ActivityEvent.record(
                requirement.project.lead,
                ActivityEvent.Category.PHASE,
                f'Custom task "{requirement.label}" added to phase {requirement.phase}',
                actor=user,
            )
        return requirement

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
                # A fresh completion never also confirms it in the same
                # request, even for a confirmation_authority the completer
                # would otherwise be eligible to confirm (e.g. the PM who
                # completes a PROJECT_MANAGER-authority Phase 2 task) --
                # completion and confirmation are deliberately separate
                # actions, so confirming always takes its own subsequent
                # PATCH (validate() only lets this branch run for whoever
                # this task's phase says may complete it in the first place).
                validated_data['completed_at'] = timezone.now()
            else:
                can_confirm = False
                if instance.confirmation_authority == PhaseRequirement.ConfirmationAuthority.MANAGER:
                    can_confirm = user is not None and user.role in FULL_ACCESS_ROLES
                elif instance.confirmation_authority == PhaseRequirement.ConfirmationAuthority.PROJECT_MANAGER:
                    can_confirm = user is not None and (
                        user.role in FULL_ACCESS_ROLES
                        or (user.role == User.Role.PROJECT_MANAGER and instance.project.project_manager_id == user.id)
                    )
                if can_confirm:
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
                # A client-facing task completing represents confirmed client
                # contact for the timeline/last-contact display -- it no
                # longer flips the lead HOT (see LEAD_STATUS_CHANGE).
                Lead.objects.filter(pk=lead_id).update(last_activity_at=timezone.now())
            else:
                Lead.objects.filter(pk=lead_id).update(last_internal_activity_at=timezone.now())

            if new_status == PhaseRequirement.Status.COMPLETED and requirement.label == 'Budget Proposal':
                self._auto_populate_project_budget(requirement)

        return requirement

    @staticmethod
    def _auto_populate_project_budget(requirement):
        # "Automatic pipeline updates from tasks": completing the Budget
        # Proposal task feeds its answers straight into the project-level
        # budget panel, rather than requiring someone to re-key the same
        # figures a second time. Fresh query (not requirement.form_responses
        # off a possibly-prefetched instance) so this always sees what was
        # actually just saved through the answers action.
        responses = dict(
            TaskFormResponse.objects.filter(requirement=requirement).values_list('field__label', 'value'),
        )
        project = requirement.project
        update_fields = []

        budget_value = responses.get('Proposed budget')
        if budget_value:
            try:
                project.proposed_budget = Decimal(budget_value)
                update_fields.append('proposed_budget')
            except InvalidOperation:
                pass

        currency_value = responses.get('Currency')
        if currency_value:
            project.currency = currency_value
            update_fields.append('currency')

        if update_fields:
            project.save(update_fields=update_fields)


class CalendarTaskSerializer(serializers.ModelSerializer):
    # A lightweight, purpose-built projection -- the calendar shows a task's
    # label/lead/phase and a colour category, nothing PhaseRequirementSerializer
    # otherwise carries (form fields, attachments-adjacent metadata, etc.).
    lead_id = serializers.IntegerField(source='project.lead_id', read_only=True)
    lead_name = serializers.CharField(source='project.lead.name', read_only=True)
    due_date = serializers.DateField(source='effective_due_date', read_only=True)
    calendar_status = serializers.SerializerMethodField()

    # A task due within this many days (and not already overdue) reads as
    # "due soon" rather than plain "upcoming".
    DUE_SOON_WINDOW_DAYS = 3

    class Meta:
        model = PhaseRequirement
        fields = ['id', 'label', 'phase', 'lead_id', 'lead_name', 'due_date', 'calendar_status']

    def get_calendar_status(self, obj):
        if obj.is_confirmed_complete:
            return 'COMPLETE'
        if obj.is_overdue:
            return 'OVERDUE'
        effective = obj.effective_due_date
        if effective is not None and effective <= timezone.localdate() + timedelta(days=self.DUE_SOON_WINDOW_DAYS):
            return 'DUE_SOON'
        return 'UPCOMING'


class TaskAttachmentSerializer(serializers.ModelSerializer):
    uploaded_by_username = serializers.CharField(source='uploaded_by.username', read_only=True, default=None)

    # PDF, common image types, and .docx -- matches the brief exactly, no
    # broader "any office document" allowance.
    ALLOWED_CONTENT_TYPES = {
        'application/pdf',
        'image/jpeg',
        'image/png',
        'image/gif',
        'image/webp',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    }
    MAX_FILE_SIZE_BYTES = 15 * 1024 * 1024

    class Meta:
        model = TaskAttachment
        fields = [
            'id', 'requirement', 'kind', 'file', 'url', 'title',
            'original_filename', 'content_type', 'size_bytes',
            'uploaded_by', 'uploaded_by_username', 'uploaded_at',
        ]
        read_only_fields = [
            'original_filename', 'content_type', 'size_bytes', 'uploaded_by', 'uploaded_at',
        ]
        extra_kwargs = {
            # Never rendered back to the client -- the file is only ever
            # reached through TaskAttachmentViewSet.download, and .url would
            # raise anyway (see storage.private_attachment_storage).
            'file': {'write_only': True},
        }

    def validate_file(self, value):
        if value.size > self.MAX_FILE_SIZE_BYTES:
            raise serializers.ValidationError(
                f'File is too large ({value.size // (1024 * 1024)} MB) -- the limit is 15 MB.',
            )
        content_type = getattr(value, 'content_type', '') or ''
        if content_type not in self.ALLOWED_CONTENT_TYPES:
            raise serializers.ValidationError(
                'Unsupported file type -- only PDF, images (JPEG/PNG/GIF/WebP), and .docx are allowed.',
            )
        return value

    def validate(self, attrs):
        kind = attrs.get('kind', getattr(self.instance, 'kind', None))
        file_value = attrs.get('file')
        url_value = attrs.get('url')
        errors = {}

        if kind == TaskAttachment.Kind.FILE:
            if self.instance is None and not file_value:
                errors['file'] = 'A file is required for a FILE attachment.'
            if url_value:
                errors['url'] = 'A FILE attachment cannot also have a URL.'
        elif kind == TaskAttachment.Kind.LINK:
            if self.instance is None and not url_value:
                errors['url'] = 'A URL is required for a LINK attachment.'
            if file_value:
                errors['file'] = 'A LINK attachment cannot also have a file.'
            if self.instance is None and not (attrs.get('title') or '').strip():
                errors['title'] = 'A title is required for a link attachment.'

        # Collected rather than raised as soon as the first problem is found,
        # so a client fixing a LINK submission missing both url and title
        # sees both errors in one round trip instead of one at a time.
        if errors:
            raise serializers.ValidationError(errors)
        return attrs

    def create(self, validated_data):
        request = self.context.get('request')
        file_value = validated_data.get('file')
        if validated_data.get('kind') == TaskAttachment.Kind.FILE and file_value:
            validated_data['original_filename'] = file_value.name
            validated_data['content_type'] = getattr(file_value, 'content_type', '') or ''
            validated_data['size_bytes'] = file_value.size
            if not (validated_data.get('title') or '').strip():
                validated_data['title'] = file_value.name
        if request:
            validated_data['uploaded_by'] = request.user
        return super().create(validated_data)


class RequirementTemplateSerializer(serializers.ModelSerializer):
    # Writable nested list: whatever's submitted here becomes this template's
    # complete set of form fields -- create() makes them all new, update()
    # reconciles (see _sync_form_fields) rather than patching one at a time,
    # since a manager authors a template's whole form as one coherent unit.
    form_fields = TemplateFormFieldSerializer(many=True, required=False)

    class Meta:
        model = RequirementTemplate
        fields = [
            'id', 'phase', 'label', 'description', 'order',
            'confirmation_authority', 'client_facing', 'default_duration_days', 'is_active',
            'form_fields',
        ]

    def create(self, validated_data):
        form_fields_data = validated_data.pop('form_fields', [])
        template = super().create(validated_data)
        for field_data in form_fields_data:
            field_data.pop('id', None)  # ignore if somehow present -- there's nothing to match yet
            TaskFormField.objects.create(template=template, **field_data)
        return template

    def update(self, instance, validated_data):
        form_fields_data = validated_data.pop('form_fields', None)
        template = super().update(instance, validated_data)
        if form_fields_data is not None:
            self._sync_form_fields(template, form_fields_data)
        return template

    @staticmethod
    def _sync_form_fields(template, form_fields_data):
        # The submitted list is the field set's new complete state: matched
        # by id to update in place, id-less entries are new fields, and any
        # existing field not present at all is a deletion (add/edit/reorder/
        # delete, all through the same "resend the whole list" shape).
        existing = {f.id: f for f in template.form_fields.all()}
        seen_ids = set()
        for field_data in form_fields_data:
            field_id = field_data.pop('id', None)
            if field_id is not None and field_id in existing:
                field = existing[field_id]
                for attr, value in field_data.items():
                    setattr(field, attr, value)
                field.save()
                seen_ids.add(field_id)
            else:
                created = TaskFormField.objects.create(template=template, **field_data)
                seen_ids.add(created.id)
        TaskFormField.objects.filter(template=template).exclude(id__in=seen_ids).delete()


class ApprovalRequestSerializer(serializers.ModelSerializer):
    requested_by_username = serializers.CharField(source='requested_by.username', read_only=True, default=None)
    decided_by_username = serializers.CharField(source='decided_by.username', read_only=True, default=None)
    lead_name = serializers.SerializerMethodField()
    company_name = serializers.SerializerMethodField()
    phase_number = serializers.SerializerMethodField()

    LEAD_TARGET_TYPES = {ApprovalRequest.RequestType.ARCHIVE_LEAD, ApprovalRequest.RequestType.LEAD_STATUS_CHANGE}
    PHASE_SIGNOFF_PHASE_NUMBERS = {
        ApprovalRequest.RequestType.PHASE_1_SIGNOFF: 1,
        ApprovalRequest.RequestType.PHASE_2_SIGNOFF: 2,
        ApprovalRequest.RequestType.PHASE_3_SIGNOFF: 3,
        ApprovalRequest.RequestType.PHASE_4_SIGNOFF: 4,
    }

    class Meta:
        model = ApprovalRequest
        fields = [
            'id', 'request_type', 'lead', 'project', 'target_status', 'status', 'reason', 'decision_note',
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
            for field_name in ('request_type', 'lead', 'project', 'reason', 'target_status'):
                self.fields[field_name].read_only = True
        else:
            self.fields['status'].read_only = True

    def validate(self, attrs):
        if self.instance is None:
            lead, project = attrs.get('lead'), attrs.get('project')
            if bool(lead) == bool(project):
                raise serializers.ValidationError('Provide exactly one of lead or project.')
            request_type = attrs.get('request_type')
            if request_type in self.LEAD_TARGET_TYPES and lead is None:
                raise serializers.ValidationError({'lead': 'This request type must target a lead.'})
            if request_type not in self.LEAD_TARGET_TYPES and project is None:
                raise serializers.ValidationError({'project': 'Phase signoff requests must target a project.'})

            request = self.context.get('request')
            if (
                request
                and request.user.role == User.Role.SALES_REP
                and lead is not None
                and lead.assigned_to_id != request.user.id
            ):
                # Otherwise a rep could raise a request (ARCHIVE_LEAD or
                # LEAD_STATUS_CHANGE) against a lead assigned to someone
                # else, and it would land in the manager's queue looking
                # exactly as legitimate as one from the assigned rep.
                raise serializers.ValidationError({'lead': 'You can only raise this request for a lead assigned to you.'})

            if request_type == ApprovalRequest.RequestType.LEAD_STATUS_CHANGE:
                if not attrs.get('target_status'):
                    raise serializers.ValidationError({'target_status': 'target_status (HOT or COLD) is required.'})
                if not (attrs.get('reason') or '').strip():
                    raise serializers.ValidationError({'reason': 'A reason is required for a status change request.'})
            # No manual duplicate-pending check here: ModelSerializer already
            # derives a condition-aware UniqueTogetherValidator from the
            # model's UniqueConstraint (see ApprovalRequest.Meta), which runs
            # before this method and raises first with the same message.
        else:
            new_status = attrs.get('status')
            if new_status and new_status == ApprovalRequest.Status.PENDING:
                raise serializers.ValidationError({'status': 'Status can only be changed to APPROVED or REJECTED.'})
            if (
                new_status == ApprovalRequest.Status.APPROVED
                and self.instance.request_type == ApprovalRequest.RequestType.PHASE_1_SIGNOFF
                and self.instance.project is not None
                and self.instance.project.project_manager_id is None
            ):
                # Phase 2 is PM-owned and can't start unassigned.
                raise serializers.ValidationError({
                    'status': (
                        'This project has no assigned project manager -- assign one before '
                        'approving Phase 1 sign-off.'
                    ),
                })
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

        if instance.request_type == ApprovalRequest.RequestType.LEAD_STATUS_CHANGE:
            lead = instance.lead
            if lead is None or lead.status == instance.target_status:
                return
            lead.status = instance.target_status
            lead.save(update_fields=['status'])
            ActivityEvent.record(
                lead,
                ActivityEvent.Category.ADMINISTRATIVE,
                # Raw enum value ("HOT"/"COLD"), matching the phrasing the
                # direct-PATCH path already uses in LeadSerializer.update.
                f'Status changed to {lead.status}: {instance.reason}',
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
        if getattr(project, field_name) != Project.PhaseStatus.AWAITING_APPROVAL:
            return

        setattr(project, field_name, Project.PhaseStatus.IN_PROGRESS)
        update_fields = [field_name]
        if phase_num == 3:
            # Phase 3's sign-off is raised by the execution status reaching
            # Completed, not by a separate manual action -- rejecting it
            # reverts that same axis back to Review (one step short of the
            # Completed that triggered it) so the PM has somewhere sensible
            # to resume from, not just the bare phase status.
            old_execution_status = project.phase_3_execution_status
            project.phase_3_execution_status = Project.ExecutionStatus.REVIEW
            update_fields.append('phase_3_execution_status')
        project.save(update_fields=update_fields)

        if phase_num == 3 and old_execution_status != Project.ExecutionStatus.REVIEW:
            ExecutionStatusEvent.objects.create(
                project=project,
                from_status=old_execution_status,
                to_status=Project.ExecutionStatus.REVIEW,
                changed_by=instance.decided_by,
            )


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
