import re
from datetime import timedelta

from django.contrib.auth.models import AbstractUser
from django.core.validators import MaxValueValidator, MinValueValidator
from django.db import models
from django.utils import timezone

from .storage import PrivateAttachmentStorage

# Matches "@username" tokens in free text -- only word characters (letters,
# digits, underscore), which covers every username actually seeded/used in
# this app. Anchored to start-of-string or a preceding whitespace character
# (via lookbehind, since a variable-width alternation can't sit inside a
# lookbehind directly) so "email@domain" isn't misread as a mention of
# "domain".
MENTION_PATTERN = re.compile(r'(?:^|(?<=\s))@(\w+)')

# Matches "#<id>" task references -- the PhaseRequirement's numeric primary
# key, the same "#123" convention issue trackers use, not its (often
# multi-word) label. The autocomplete inserts this token directly; rendering
# it back as the task's actual label is the frontend/serializer's job.
TASK_REFERENCE_PATTERN = re.compile(r'(?:^|(?<=\s))#(\d+)')


class User(AbstractUser):
    class Role(models.TextChoices):
        SALES_REP = 'SALES_REP', 'Sales Rep'
        SALES_MANAGER = 'SALES_MANAGER', 'Sales Manager'
        EXECUTIVE_MANAGER = 'EXECUTIVE_MANAGER', 'Executive Manager'
        PROJECT_MANAGER = 'PROJECT_MANAGER', 'Project Manager'
        SYSTEM_ADMIN = 'SYSTEM_ADMIN', 'System Admin'

    role = models.CharField(
        max_length=32,
        choices=Role.choices,
        default=Role.SALES_REP,
    )

    def __str__(self):
        return self.username


class Company(models.Model):
    name = models.CharField(max_length=255)
    industry = models.CharField(max_length=255, blank=True)
    website = models.URLField(blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    owner = models.ForeignKey(
        User,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='owned_companies',
    )
    is_archived = models.BooleanField(default=False)
    archived_by = models.ForeignKey(
        User,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='archived_companies',
    )
    archived_at = models.DateTimeField(null=True, blank=True)
    archive_reason = models.TextField(blank=True)

    class Meta:
        verbose_name_plural = 'Companies'

    def __str__(self):
        return self.name


class Contact(models.Model):
    company = models.ForeignKey(
        Company,
        on_delete=models.CASCADE,
        related_name='contacts',
    )
    name = models.CharField(max_length=255)
    email = models.EmailField(blank=True)
    phone = models.CharField(max_length=32, blank=True)
    job_title = models.CharField(max_length=255, blank=True)
    is_archived = models.BooleanField(default=False)
    archived_by = models.ForeignKey(
        User,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='archived_contacts',
    )
    archived_at = models.DateTimeField(null=True, blank=True)
    archive_reason = models.TextField(blank=True)

    def __str__(self):
        return self.name


class Lead(models.Model):
    class Status(models.TextChoices):
        HOT = 'HOT', 'Hot'
        COLD = 'COLD', 'Cold'

    # The primary display identity for a lead -- e.g. "Wayne Enterprises —
    # Q3 infrastructure upgrade" -- shown everywhere a lead appears, in place
    # of the company/contact combination that used to stand in for it.
    name = models.CharField(max_length=200)
    company = models.ForeignKey(
        Company,
        on_delete=models.CASCADE,
        related_name='leads',
    )
    contact = models.ForeignKey(
        Contact,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='leads',
    )
    status = models.CharField(
        max_length=8,
        choices=Status.choices,
        default=Status.COLD,
    )
    created_at = models.DateTimeField(auto_now_add=True)
    last_activity_at = models.DateTimeField(auto_now=True)
    last_internal_activity_at = models.DateTimeField(null=True, blank=True)
    assigned_to = models.ForeignKey(
        User,
        on_delete=models.CASCADE,
        related_name='assigned_leads',
    )
    is_archived = models.BooleanField(default=False)
    archived_by = models.ForeignKey(
        User,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='archived_leads',
    )
    archived_at = models.DateTimeField(null=True, blank=True)
    archive_reason = models.TextField(blank=True)

    def __str__(self):
        return self.name

    def save(self, *args, **kwargs):
        is_new = self._state.adding
        super().save(*args, **kwargs)
        if is_new:
            # Project is defined later in this module; that's fine since
            # this only resolves at call time, well after import.
            project = Project.objects.create(
                lead=self,
                company=self.company,
                phase_1_status=Project.PhaseStatus.IN_PROGRESS,
            )
            project.start_phase(1)


class Deal(models.Model):
    class Stage(models.TextChoices):
        NEW_LEAD = 'NEW_LEAD', 'New Lead'
        CONTACTED = 'CONTACTED', 'Contacted'
        PROPOSAL = 'PROPOSAL', 'Proposal'
        NEGOTIATION = 'NEGOTIATION', 'Negotiation'
        CLOSED_WON = 'CLOSED_WON', 'Closed Won'
        CLOSED_LOST = 'CLOSED_LOST', 'Closed Lost'

    company = models.ForeignKey(
        Company,
        on_delete=models.CASCADE,
        related_name='deals',
    )
    contact = models.ForeignKey(
        Contact,
        on_delete=models.CASCADE,
        null=True,
        blank=True,
        related_name='deals',
    )
    stage = models.CharField(
        max_length=16,
        choices=Stage.choices,
        default=Stage.NEW_LEAD,
    )
    value = models.DecimalField(max_digits=12, decimal_places=2, null=True, blank=True)
    assigned_to = models.ForeignKey(
        User,
        on_delete=models.CASCADE,
        related_name='assigned_deals',
    )

    def __str__(self):
        return f'{self.company} - {self.get_stage_display()}'


class Interaction(models.Model):
    class Type(models.TextChoices):
        CALL = 'CALL', 'Call'
        EMAIL = 'EMAIL', 'Email'
        MEETING = 'MEETING', 'Meeting'
        NOTE = 'NOTE', 'Note'

    class Outcome(models.TextChoices):
        RESPONDED = 'RESPONDED', 'Responded'
        NO_ANSWER = 'NO_ANSWER', 'No Answer'
        MISSED_CALL = 'MISSED_CALL', 'Missed Call'
        LEFT_MESSAGE = 'LEFT_MESSAGE', 'Left Message'
        BOUNCED = 'BOUNCED', 'Bounced'

    lead = models.ForeignKey(
        Lead,
        on_delete=models.CASCADE,
        related_name='interactions',
    )
    type = models.CharField(
        max_length=8,
        choices=Type.choices,
    )
    outcome = models.CharField(
        max_length=12,
        choices=Outcome.choices,
        default=Outcome.RESPONDED,
        null=True,
        blank=True,
    )
    notes = models.TextField(blank=True)
    occurred_at = models.DateTimeField(default=timezone.now)
    created_by = models.ForeignKey(
        User,
        on_delete=models.CASCADE,
        related_name='created_interactions',
    )

    class Meta:
        ordering = ['-occurred_at']

    def __str__(self):
        return f'{self.get_type_display()} on {self.lead}'

    @property
    def assigned_to_id(self):
        # Lets RoleBasedAccess.has_object_permission scope this the same
        # way it scopes a Lead, without duplicating the permission class.
        return self.lead.assigned_to_id

    @property
    def project_manager_id(self):
        # Lets a PROJECT_MANAGER write an existing interaction logged against
        # a lead whose project they manage (see RoleBasedAccess) -- needed so
        # a PM can, for example, edit a note after tagging a task in it.
        return self.lead.project.project_manager_id

    # Roles whose task references ("#42") actually notify the responsible
    # person -- a rep's or an admin's #reference still renders as a link in
    # the timeline (see InteractionSerializer.get_referenced_tasks), it just
    # doesn't page anyone.
    TASK_TAG_NOTIFY_ROLES = {User.Role.SALES_MANAGER, User.Role.EXECUTIVE_MANAGER, User.Role.PROJECT_MANAGER}

    def save(self, *args, **kwargs):
        super().save(*args, **kwargs)
        # QuerySet.update() bypasses Lead.last_activity_at's auto_now, so
        # occurred_at (which may be backdated) sticks instead of "now". A
        # RESPONDED outcome no longer flips the lead HOT -- that's now a
        # manual call (direct manager PATCH or an approved
        # LEAD_STATUS_CHANGE request; see ApprovalRequestSerializer).
        if self.type == Interaction.Type.NOTE or self.outcome == Interaction.Outcome.RESPONDED:
            Lead.objects.filter(pk=self.lead_id).update(last_activity_at=self.occurred_at)
        self._create_user_mentions()
        self._create_task_mentions()

    def _create_user_mentions(self):
        # Mention is defined later in this module; that's fine since this
        # only resolves at call time, well after import (same pattern as
        # Project.save()'s forward reference to PhaseRequirement).
        usernames = set(MENTION_PATTERN.findall(self.notes or ''))
        if not usernames:
            return
        for username in usernames:
            user = User.objects.filter(username__iexact=username).exclude(pk=self.created_by_id).first()
            if user is None:
                # Unknown username, or the author mentioning themselves --
                # both are silently ignored, not an error.
                continue
            # get_or_create rather than a blind create(): save() runs on
            # every update too (e.g. editing notes), and re-parsing the same
            # already-mentioned name shouldn't raise or duplicate-notify.
            Mention.objects.get_or_create(
                user=user, interaction=self, task=None, defaults={'created_by_id': self.created_by_id},
            )

    def _create_task_mentions(self):
        # Only a manager or PM tagging a task notifies anyone -- a rep
        # referencing a task (typically their own) isn't "assigning" it to
        # someone, so it's just a link, not a notification.
        if self.created_by.role not in self.TASK_TAG_NOTIFY_ROLES:
            return
        task_ids = {int(m) for m in TASK_REFERENCE_PATTERN.findall(self.notes or '')}
        if not task_ids:
            return
        # Scoped to this interaction's own project -- a stray id belonging to
        # some other lead's task is treated the same as an unknown one.
        # (Lead.project is a reverse OneToOne descriptor, not a field, so
        # there's no project_id shortcut here the way there is on Project.)
        tasks = PhaseRequirement.objects.filter(pk__in=task_ids, project=self.lead.project)
        for task in tasks:
            responsible = task.responsible_user
            if responsible is None or responsible.id == self.created_by_id:
                # Nobody currently responsible (e.g. no PM assigned yet), or
                # the tagger tagging their own task -- both silently ignored.
                continue
            Mention.objects.get_or_create(
                user=responsible, interaction=self, task=task, defaults={'created_by_id': self.created_by_id},
            )


class RequirementTemplate(models.Model):
    class ConfirmationAuthority(models.TextChoices):
        REP = 'REP', 'Rep'
        PROJECT_MANAGER = 'PROJECT_MANAGER', 'Project Manager'
        MANAGER = 'MANAGER', 'Manager'

    phase = models.PositiveSmallIntegerField(validators=[MinValueValidator(1), MaxValueValidator(4)])
    label = models.CharField(max_length=255)
    description = models.TextField(blank=True)
    order = models.PositiveIntegerField(default=0)
    confirmation_authority = models.CharField(
        max_length=16,
        choices=ConfirmationAuthority.choices,
        default=ConfirmationAuthority.REP,
    )
    # Marks a task as representing confirmed client contact -- completing one
    # updates the lead's last_activity_at and sets it HOT, the same as a
    # RESPONDED interaction (see PhaseRequirementSerializer.update). A task
    # without it only updates last_internal_activity_at.
    client_facing = models.BooleanField(default=False)
    # Days from that phase's start date until this task is due -- null means
    # no deadline. Copied onto each generated PhaseRequirement (see
    # Project.save()) so a later template edit doesn't retroactively change
    # an already-running project's due dates.
    default_duration_days = models.PositiveIntegerField(null=True, blank=True)
    is_active = models.BooleanField(default=True)

    class Meta:
        ordering = ['phase', 'order', 'id']

    def __str__(self):
        return f'{self.label} (phase {self.phase})'


class Project(models.Model):
    class PhaseStatus(models.TextChoices):
        NOT_STARTED = 'NOT_STARTED', 'Not Started'
        IN_PROGRESS = 'IN_PROGRESS', 'In Progress'
        AWAITING_APPROVAL = 'AWAITING_APPROVAL', 'Awaiting Approval'
        COMPLETE = 'COMPLETE', 'Complete'

    class ExecutionStatus(models.TextChoices):
        STARTED = 'STARTED', 'Started'
        BUILDING = 'BUILDING', 'Building'
        TESTING = 'TESTING', 'Testing'
        REVIEW = 'REVIEW', 'Review'
        COMPLETED = 'COMPLETED', 'Completed'

    lead = models.OneToOneField(
        Lead,
        on_delete=models.CASCADE,
        related_name='project',
    )
    company = models.ForeignKey(
        Company,
        on_delete=models.CASCADE,
        related_name='projects',
    )
    deal = models.ForeignKey(
        Deal,
        on_delete=models.CASCADE,
        null=True,
        blank=True,
        related_name='projects',
    )
    # Assigned by a manager once Phase 1 is ready to hand off -- Phase 2 is
    # PM-owned and (see ApprovalRequestSerializer) can't start without one.
    project_manager = models.ForeignKey(
        User,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='managed_projects',
    )
    current_phase = models.PositiveSmallIntegerField(
        default=1,
        validators=[MinValueValidator(1), MaxValueValidator(4)],
    )
    # proposed_budget/currency are normally set automatically when the Budget
    # Proposal task's form is completed (see PhaseRequirementSerializer.
    # update()) -- direct writes are restricted to the managing PM and
    # management roles (see ProjectSerializer.__init__).
    proposed_budget = models.DecimalField(max_digits=12, decimal_places=2, null=True, blank=True)
    currency = models.CharField(max_length=8, blank=True)
    notes = models.TextField(blank=True)
    phase_1_status = models.CharField(max_length=20, choices=PhaseStatus.choices, default=PhaseStatus.NOT_STARTED)
    phase_2_status = models.CharField(max_length=20, choices=PhaseStatus.choices, default=PhaseStatus.NOT_STARTED)
    phase_3_status = models.CharField(max_length=20, choices=PhaseStatus.choices, default=PhaseStatus.NOT_STARTED)
    phase_4_status = models.CharField(max_length=20, choices=PhaseStatus.choices, default=PhaseStatus.NOT_STARTED)
    # Separate axis from phase_3_status -- see ProjectSerializer.update()/
    # ExecutionStatusEvent for how a change here is gated and logged.
    phase_3_execution_status = models.CharField(
        max_length=16,
        choices=ExecutionStatus.choices,
        null=True,
        blank=True,
    )
    phase_1_started_at = models.DateTimeField(null=True, blank=True)
    phase_2_started_at = models.DateTimeField(null=True, blank=True)
    phase_3_started_at = models.DateTimeField(null=True, blank=True)
    phase_4_started_at = models.DateTimeField(null=True, blank=True)
    maintenance = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    is_archived = models.BooleanField(default=False)
    archived_by = models.ForeignKey(
        User,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='archived_projects',
    )
    archived_at = models.DateTimeField(null=True, blank=True)
    archive_reason = models.TextField(blank=True)

    def __str__(self):
        return f'Project for {self.company} (phase {self.current_phase})'

    @property
    def owner_id(self):
        # Lets the permission classes scope this exactly like a Company,
        # without duplicating their ownership logic.
        return self.company.owner_id

    @property
    def assigned_to_id(self):
        # Lets ArchivableOwnedResourcePermission also grant a rep access via
        # "assigned the linked lead", not just "owns the company" -- a rep
        # can be assigned a lead on a company they don't own.
        return self.lead.assigned_to_id

    PHASE_STARTED_AT_FIELDS = {
        1: 'phase_1_started_at', 2: 'phase_2_started_at', 3: 'phase_3_started_at', 4: 'phase_4_started_at',
    }

    def save(self, *args, **kwargs):
        is_new = self._state.adding
        super().save(*args, **kwargs)
        if is_new:
            # PhaseRequirement is defined later in this module; that's fine
            # since this only resolves at call time, well after import.
            PhaseRequirement.objects.bulk_create([
                PhaseRequirement(
                    project=self,
                    template=template,
                    phase=template.phase,
                    label=template.label,
                    description=template.description,
                    confirmation_authority=template.confirmation_authority,
                    client_facing=template.client_facing,
                    default_duration_days=template.default_duration_days,
                )
                for template in RequirementTemplate.objects.filter(is_active=True).order_by('phase', 'order')
            ])

    def start_phase(self, phase_num):
        # Idempotent: a phase only "starts" once, so a sign-off rejection
        # that reverts AWAITING_APPROVAL back to IN_PROGRESS (or any other
        # re-entry) doesn't reset its start date or recompute due dates.
        field_name = self.PHASE_STARTED_AT_FIELDS[phase_num]
        if getattr(self, field_name) is not None:
            return
        now = timezone.now()
        setattr(self, field_name, now)
        self.save(update_fields=[field_name])

        start_date = now.date()
        requirements = list(self.requirements.filter(phase=phase_num, default_duration_days__isnull=False))
        for requirement in requirements:
            requirement.due_date = start_date + timedelta(days=requirement.default_duration_days)
        PhaseRequirement.objects.bulk_update(requirements, ['due_date'])


class PhaseRequirement(models.Model):
    class Status(models.TextChoices):
        PENDING = 'PENDING', 'Pending'
        IN_PROGRESS = 'IN_PROGRESS', 'In Progress'
        COMPLETED = 'COMPLETED', 'Completed'
        NOT_APPLICABLE = 'NOT_APPLICABLE', 'Not Applicable'

    class ConfirmationAuthority(models.TextChoices):
        REP = 'REP', 'Rep'
        PROJECT_MANAGER = 'PROJECT_MANAGER', 'Project Manager'
        MANAGER = 'MANAGER', 'Manager'

    project = models.ForeignKey(
        Project,
        on_delete=models.CASCADE,
        related_name='requirements',
    )
    # Set at generation time (see Project.save()) for template-derived tasks;
    # null for a custom one. This is what lets form fields be defined once on
    # the template and referenced by every task it generates, rather than
    # copied onto each -- see the form_fields property below.
    template = models.ForeignKey(
        RequirementTemplate,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='generated_requirements',
    )
    phase = models.PositiveSmallIntegerField(validators=[MinValueValidator(1), MaxValueValidator(4)])
    label = models.CharField(max_length=255)
    description = models.TextField(blank=True)
    status = models.CharField(max_length=14, choices=Status.choices, default=Status.PENDING)
    notes = models.TextField(blank=True)
    confirmation_authority = models.CharField(
        max_length=16,
        choices=ConfirmationAuthority.choices,
        default=ConfirmationAuthority.REP,
    )
    client_facing = models.BooleanField(default=False)
    # True only for a task created directly via the API (see
    # PhaseRequirementSerializer.create) rather than bulk-generated from a
    # RequirementTemplate by Project.save() -- gates deletion (only a custom
    # task can be deleted; a template-derived one never can).
    is_custom = models.BooleanField(default=False)
    created_by = models.ForeignKey(
        User,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='created_requirements',
    )
    # Snapshotted from the template at creation time -- see Project.save().
    default_duration_days = models.PositiveIntegerField(null=True, blank=True)
    # System-calculated at phase start (see Project.start_phase); not
    # directly editable via the API.
    due_date = models.DateField(null=True, blank=True)
    # Set by the assigned rep or a manager when a client agrees a date on a
    # call -- takes precedence over due_date when both are set (see
    # effective_due_date below).
    committed_date = models.DateField(null=True, blank=True)
    updated_by = models.ForeignKey(
        User,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='updated_requirements',
    )
    updated_at = models.DateTimeField(auto_now=True)
    completed_at = models.DateTimeField(null=True, blank=True)
    confirmed_by = models.ForeignKey(
        User,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='confirmed_requirements',
    )
    confirmed_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ['phase', 'id']

    def __str__(self):
        return f'{self.label} (phase {self.phase})'

    @property
    def owner_id(self):
        # Lets RoleBasedAccess.has_object_permission scope this exactly like
        # a Company/Project, without a bespoke permission class.
        return self.project.company.owner_id

    @property
    def assigned_to_id(self):
        # Same rationale as Project.assigned_to_id -- a rep assigned the
        # lead should be able to work its tasks even without owning the
        # company.
        return self.project.lead.assigned_to_id

    @property
    def project_manager_id(self):
        # Lets the permission classes grant a PROJECT_MANAGER write access
        # via "manages this task's project", without a bespoke permission
        # class -- same pattern as owner_id/assigned_to_id above.
        return self.project.project_manager_id

    # Who may move a task INTO Completed (see PhaseRequirementSerializer's
    # completion-authority gate) -- and, by the same rule, who a task
    # reference notifies: Phase 1/4 are the assigned rep's, Phase 2/3 are the
    # assigned PM's.
    COMPLETION_ROLE_BY_PHASE = {
        1: User.Role.SALES_REP,
        2: User.Role.PROJECT_MANAGER,
        3: User.Role.PROJECT_MANAGER,
        4: User.Role.SALES_REP,
    }

    @property
    def responsible_user(self):
        role = self.COMPLETION_ROLE_BY_PHASE.get(self.phase)
        if role == User.Role.SALES_REP:
            return self.project.lead.assigned_to
        if role == User.Role.PROJECT_MANAGER:
            return self.project.project_manager
        return None

    @property
    def is_confirmed_complete(self):
        if self.status != self.Status.COMPLETED:
            return False
        if self.confirmation_authority in (
            self.ConfirmationAuthority.MANAGER, self.ConfirmationAuthority.PROJECT_MANAGER,
        ):
            return self.confirmed_by_id is not None
        return True

    @property
    def effective_due_date(self):
        # The earlier of the system-calculated due_date and a client-agreed
        # committed_date, ignoring whichever (if either) is null.
        dates = [d for d in (self.due_date, self.committed_date) if d is not None]
        return min(dates) if dates else None

    @property
    def is_overdue(self):
        if self.status == self.Status.NOT_APPLICABLE or self.is_confirmed_complete:
            return False
        effective = self.effective_due_date
        return effective is not None and effective < timezone.localdate()

    @property
    def completed_late(self):
        if not self.is_confirmed_complete or self.completed_at is None:
            return False
        effective = self.effective_due_date
        return effective is not None and self.completed_at.date() > effective

    @property
    def form_fields(self):
        # By reference, not copied: a template-derived task's fields live on
        # the template and are shared by every task it generates; a custom
        # task (no template) defines its own directly.
        if self.template_id is not None:
            return self.template.form_fields.all()
        return self.custom_form_fields.all()


class TaskFormField(models.Model):
    class FieldType(models.TextChoices):
        TEXT = 'TEXT', 'Text'
        TEXTAREA = 'TEXTAREA', 'Textarea'
        NUMBER = 'NUMBER', 'Number'
        CURRENCY = 'CURRENCY', 'Currency'
        DATE = 'DATE', 'Date'
        SELECT = 'SELECT', 'Select'
        CHECKBOX = 'CHECKBOX', 'Checkbox'

    # Exactly one of these is set. template-owned fields are shared by every
    # PhaseRequirement that template generates (see form_fields property
    # above); requirement-owned fields belong to one specific custom task,
    # which has no template to attach to.
    template = models.ForeignKey(
        RequirementTemplate,
        on_delete=models.CASCADE,
        null=True,
        blank=True,
        related_name='form_fields',
    )
    requirement = models.ForeignKey(
        PhaseRequirement,
        on_delete=models.CASCADE,
        null=True,
        blank=True,
        related_name='custom_form_fields',
    )
    label = models.CharField(max_length=255)
    field_type = models.CharField(max_length=10, choices=FieldType.choices)
    # Only meaningful for field_type=SELECT -- a plain list of option strings.
    options = models.JSONField(default=list, blank=True)
    required = models.BooleanField(default=False)
    order = models.PositiveIntegerField(default=0)
    help_text = models.CharField(max_length=255, blank=True)

    class Meta:
        ordering = ['order', 'id']
        constraints = [
            models.CheckConstraint(
                condition=(
                    models.Q(template__isnull=False, requirement__isnull=True)
                    | models.Q(template__isnull=True, requirement__isnull=False)
                ),
                name='taskformfield_exactly_one_owner',
            ),
        ]

    def __str__(self):
        return self.label


class TaskFormResponse(models.Model):
    requirement = models.ForeignKey(
        PhaseRequirement,
        on_delete=models.CASCADE,
        related_name='form_responses',
    )
    field = models.ForeignKey(
        TaskFormField,
        on_delete=models.CASCADE,
        related_name='responses',
    )
    # Plain text regardless of field_type -- a NUMBER/CURRENCY/DATE/CHECKBOX
    # value stored as its string form, rather than a polymorphic value
    # column, since nothing here needs to query or aggregate on it.
    value = models.TextField(blank=True)
    answered_by = models.ForeignKey(
        User,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='task_form_responses',
    )
    answered_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['field__order', 'id']
        constraints = [
            models.UniqueConstraint(fields=['requirement', 'field'], name='taskformresponse_one_per_requirement_field'),
        ]

    def __str__(self):
        return f'{self.field.label} = {self.value!r}'


def _attachment_upload_path(instance, filename):
    # Namespaced by requirement so two tasks' files never collide; the
    # requirement FK is already set on the instance by the time Django saves
    # the file (it's assigned before .save() is called).
    return f'task_attachments/{instance.requirement_id}/{filename}'


class TaskAttachment(models.Model):
    class Kind(models.TextChoices):
        FILE = 'FILE', 'File'
        LINK = 'LINK', 'Link'

    requirement = models.ForeignKey(
        PhaseRequirement,
        on_delete=models.CASCADE,
        related_name='attachments',
    )
    kind = models.CharField(max_length=4, choices=Kind.choices)
    # Exactly one of file/url is set, matching kind -- enforced in
    # TaskAttachmentSerializer.validate, not at the DB level.
    file = models.FileField(
        upload_to=_attachment_upload_path,
        storage=PrivateAttachmentStorage,
        null=True,
        blank=True,
    )
    url = models.URLField(max_length=1000, null=True, blank=True)
    title = models.CharField(max_length=255, blank=True)
    # Only meaningful for kind=FILE -- captured at upload time.
    original_filename = models.CharField(max_length=255, blank=True)
    content_type = models.CharField(max_length=100, blank=True)
    size_bytes = models.PositiveIntegerField(null=True, blank=True)
    uploaded_by = models.ForeignKey(
        User,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='task_attachments',
    )
    uploaded_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['-uploaded_at']

    def __str__(self):
        return self.title or self.original_filename or self.url or f'Attachment {self.pk}'


class ExecutionStatusEvent(models.Model):
    project = models.ForeignKey(
        Project,
        on_delete=models.CASCADE,
        related_name='execution_status_events',
    )
    from_status = models.CharField(
        max_length=16,
        choices=Project.ExecutionStatus.choices,
        null=True,
        blank=True,
    )
    to_status = models.CharField(max_length=16, choices=Project.ExecutionStatus.choices)
    changed_by = models.ForeignKey(
        User,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='execution_status_events',
    )
    changed_at = models.DateTimeField(auto_now_add=True)
    note = models.TextField(blank=True)

    class Meta:
        ordering = ['-changed_at']

    def __str__(self):
        return f'{self.project}: {self.from_status} -> {self.to_status}'


class ApprovalRequest(models.Model):
    class RequestType(models.TextChoices):
        ARCHIVE_LEAD = 'ARCHIVE_LEAD', 'Archive Lead'
        LEAD_STATUS_CHANGE = 'LEAD_STATUS_CHANGE', 'Lead Status Change'
        PHASE_1_SIGNOFF = 'PHASE_1_SIGNOFF', 'Phase 1 Signoff'
        PHASE_2_SIGNOFF = 'PHASE_2_SIGNOFF', 'Phase 2 Signoff'
        PHASE_3_SIGNOFF = 'PHASE_3_SIGNOFF', 'Phase 3 Signoff'
        PHASE_4_SIGNOFF = 'PHASE_4_SIGNOFF', 'Phase 4 Signoff'

    class Status(models.TextChoices):
        PENDING = 'PENDING', 'Pending'
        APPROVED = 'APPROVED', 'Approved'
        REJECTED = 'REJECTED', 'Rejected'

    request_type = models.CharField(max_length=20, choices=RequestType.choices)
    lead = models.ForeignKey(
        Lead,
        on_delete=models.CASCADE,
        null=True,
        blank=True,
        related_name='approval_requests',
    )
    project = models.ForeignKey(
        Project,
        on_delete=models.CASCADE,
        null=True,
        blank=True,
        related_name='approval_requests',
    )
    requested_by = models.ForeignKey(
        User,
        on_delete=models.CASCADE,
        related_name='approval_requests_made',
    )
    decided_by = models.ForeignKey(
        User,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='approval_requests_decided',
    )
    status = models.CharField(max_length=8, choices=Status.choices, default=Status.PENDING)
    reason = models.TextField(blank=True)
    # Only meaningful for LEAD_STATUS_CHANGE requests -- the status the
    # request is asking to move the lead to.
    target_status = models.CharField(
        max_length=8,
        choices=Lead.Status.choices,
        null=True,
        blank=True,
    )
    decision_note = models.TextField(blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    decided_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ['-created_at']
        constraints = [
            models.CheckConstraint(
                condition=(
                    models.Q(lead__isnull=False, project__isnull=True)
                    | models.Q(lead__isnull=True, project__isnull=False)
                ),
                name='approvalrequest_exactly_one_target',
            ),
            models.UniqueConstraint(
                fields=['project', 'request_type'],
                # Literal 'PENDING' rather than Status.PENDING: nested class
                # bodies (Meta here) don't see names from the enclosing
                # class body, so Status isn't in scope at this point.
                condition=models.Q(status='PENDING'),
                name='approvalrequest_one_pending_per_project_type',
                # DRF's ModelSerializer auto-derives a condition-aware
                # UniqueTogetherValidator from this constraint (including
                # this message), so this is what actually surfaces from the
                # API -- no separate serializer-level check needed.
                violation_error_message=(
                    'A pending approval request of this type already exists for this project.'
                ),
            ),
            models.UniqueConstraint(
                fields=['lead', 'request_type'],
                # Mirrors the project constraint above, for the request
                # types (ARCHIVE_LEAD, LEAD_STATUS_CHANGE) that target a
                # lead instead of a project.
                condition=models.Q(status='PENDING'),
                name='approvalrequest_one_pending_per_lead_type',
                violation_error_message=(
                    'A pending approval request of this type already exists for this lead.'
                ),
            ),
        ]

    def __str__(self):
        return f'{self.get_request_type_display()} ({self.status})'

    @property
    def target(self):
        return self.lead or self.project


class ActivityEvent(models.Model):
    class Category(models.TextChoices):
        DESTRUCTIVE = 'DESTRUCTIVE', 'Destructive'
        ADMINISTRATIVE = 'ADMINISTRATIVE', 'Administrative'
        PHASE = 'PHASE', 'Phase'

    lead = models.ForeignKey(
        Lead,
        on_delete=models.CASCADE,
        related_name='activity_events',
    )
    category = models.CharField(max_length=20, choices=Category.choices)
    description = models.TextField()
    actor = models.ForeignKey(
        User,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='activity_events',
    )
    occurred_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['-occurred_at']

    def __str__(self):
        return f'{self.get_category_display()}: {self.description}'

    @classmethod
    def record(cls, lead, category, description, actor=None):
        # Purely an audit-log write -- callers decide for themselves whether
        # (and which of) Lead.last_activity_at/last_internal_activity_at
        # should also move, since that varies even within a single category
        # (e.g. a PHASE event from a client_facing task completion vs. any
        # other task/phase change -- see PhaseRequirementSerializer.update).
        return cls.objects.create(lead=lead, category=category, description=description, actor=actor)


class Mention(models.Model):
    user = models.ForeignKey(
        User,
        on_delete=models.CASCADE,
        related_name='mentions',
    )
    interaction = models.ForeignKey(
        Interaction,
        on_delete=models.CASCADE,
        related_name='mentions',
    )
    # Null for a plain "@username" mention; set when this notification exists
    # because a manager/PM referenced this task ("#42") instead -- see
    # Interaction._create_task_mentions. Same model either way, per "extend
    # Mention with a nullable task FK rather than a parallel model".
    task = models.ForeignKey(
        PhaseRequirement,
        on_delete=models.CASCADE,
        null=True,
        blank=True,
        related_name='mentions',
    )
    created_by = models.ForeignKey(
        User,
        on_delete=models.CASCADE,
        related_name='mentions_created',
    )
    created_at = models.DateTimeField(auto_now_add=True)
    read_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ['-created_at']
        constraints = [
            # A user can get at most one notification per interaction for a
            # given reason: task=NULL is the "@mention" bucket, and each
            # distinct referenced task is its own bucket -- so the same
            # interaction can notify one person twice (named directly, and
            # via their tagged task) without being a duplicate.
            models.UniqueConstraint(
                fields=['user', 'interaction', 'task'], name='mention_unique_user_interaction_task',
            ),
        ]

    def __str__(self):
        if self.task_id is not None:
            return f'task #{self.task_id} referenced for {self.user.username} in interaction {self.interaction_id}'
        return f'@{self.user.username} in interaction {self.interaction_id}'


class SystemSettings(models.Model):
    cold_lead_days = models.PositiveIntegerField(default=14)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = 'System Settings'
        verbose_name_plural = 'System Settings'

    def __str__(self):
        return 'System Settings'

    def save(self, *args, **kwargs):
        self.pk = 1
        super().save(*args, **kwargs)

    @classmethod
    def load(cls):
        obj, _ = cls.objects.get_or_create(pk=1)
        return obj
