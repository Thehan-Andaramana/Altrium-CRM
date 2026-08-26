from datetime import timedelta

from django.contrib.auth.models import AbstractUser
from django.core.validators import MaxValueValidator, MinValueValidator
from django.db import models
from django.utils import timezone


class User(AbstractUser):
    class Role(models.TextChoices):
        SALES_REP = 'SALES_REP', 'Sales Rep'
        SALES_MANAGER = 'SALES_MANAGER', 'Sales Manager'
        EXECUTIVE_MANAGER = 'EXECUTIVE_MANAGER', 'Executive Manager'
        DELIVERY_LEAD = 'DELIVERY_LEAD', 'Delivery Lead'
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
    # A manual pin on `status` -- when set, it takes precedence over every
    # automatic calculation (Interaction.save's RESPONDED/client_facing-task
    # HOT-flip, and the cold-lead job's COLD-flip), all of which check this
    # before touching status. See LeadViewSet.set_status/clear_status_override.
    status_override = models.CharField(max_length=8, choices=Status.choices, null=True, blank=True)
    status_override_reason = models.TextField(blank=True)
    status_override_by = models.ForeignKey(
        User,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='status_overrides_made',
    )
    status_override_at = models.DateTimeField(null=True, blank=True)

    def __str__(self):
        return f'{self.company} lead ({self.status})'

    @property
    def is_status_overridden(self):
        return self.status_override is not None

    def save(self, *args, **kwargs):
        is_new = self._state.adding
        super().save(*args, **kwargs)
        if is_new:
            # Project is defined later in this module; that's fine since
            # this only resolves at call time, well after import.
            Project.objects.create(
                lead=self,
                company=self.company,
                phase_1_status=Project.PhaseStatus.IN_PROGRESS,
                phase_1_started_at=timezone.now(),
            )


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

    def save(self, *args, **kwargs):
        super().save(*args, **kwargs)
        # QuerySet.update() bypasses Lead.last_activity_at's auto_now, so
        # occurred_at (which may be backdated) sticks instead of "now".
        if self.type == Interaction.Type.NOTE:
            Lead.objects.filter(pk=self.lead_id).update(last_activity_at=self.occurred_at)
        elif self.outcome == Interaction.Outcome.RESPONDED:
            Lead.objects.filter(pk=self.lead_id).update(last_activity_at=self.occurred_at)
            # A manual status_override takes precedence over this automatic
            # HOT-flip -- skip it (but the last_activity_at bump above still
            # happens; the contact genuinely occurred, override or not).
            Lead.objects.filter(pk=self.lead_id, status_override__isnull=True).update(status=Lead.Status.HOT)


class RequirementTemplate(models.Model):
    class ConfirmationAuthority(models.TextChoices):
        REP = 'REP', 'Rep'
        MANAGER = 'MANAGER', 'Manager'

    phase = models.PositiveSmallIntegerField(validators=[MinValueValidator(1), MaxValueValidator(3)])
    label = models.CharField(max_length=255)
    description = models.TextField(blank=True)
    order = models.PositiveIntegerField(default=0)
    confirmation_authority = models.CharField(
        max_length=8,
        choices=ConfirmationAuthority.choices,
        default=ConfirmationAuthority.REP,
    )
    # Marks a task as representing confirmed client contact -- completing one
    # updates the lead's last_activity_at and sets it HOT, the same as a
    # RESPONDED interaction (see PhaseRequirementSerializer.update). A task
    # without it only updates last_internal_activity_at.
    client_facing = models.BooleanField(default=False)
    # Days from the phase's start until this task is due; copied onto each
    # PhaseRequirement generated from it (see Project.save) and used there to
    # calculate that task's due_date once its phase actually starts. Null
    # means no deadline.
    default_duration_days = models.PositiveIntegerField(null=True, blank=True, validators=[MinValueValidator(1)])
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
    current_phase = models.PositiveSmallIntegerField(
        default=1,
        validators=[MinValueValidator(1), MaxValueValidator(3)],
    )
    phase_1_status = models.CharField(max_length=20, choices=PhaseStatus.choices, default=PhaseStatus.NOT_STARTED)
    phase_2_status = models.CharField(max_length=20, choices=PhaseStatus.choices, default=PhaseStatus.NOT_STARTED)
    phase_3_status = models.CharField(max_length=20, choices=PhaseStatus.choices, default=PhaseStatus.NOT_STARTED)
    # Set once, the first time each phase moves to IN_PROGRESS (see
    # ProjectSerializer._record_phase_start) -- that's also when that
    # phase's PhaseRequirement.due_date values get calculated.
    phase_1_started_at = models.DateTimeField(null=True, blank=True)
    phase_2_started_at = models.DateTimeField(null=True, blank=True)
    phase_3_started_at = models.DateTimeField(null=True, blank=True)
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

    def save(self, *args, **kwargs):
        is_new = self._state.adding
        super().save(*args, **kwargs)
        if is_new:
            # PhaseRequirement is defined later in this module; that's fine
            # since this only resolves at call time, well after import.
            # Phase 1 starts IN_PROGRESS immediately (phase_1_started_at is
            # set by the caller, Lead.save()), so its requirements' due dates
            # can be calculated right here. Phase 2/3 requirements get theirs
            # later, once those phases actually start (see
            # ProjectSerializer._record_phase_start).
            PhaseRequirement.objects.bulk_create([
                PhaseRequirement(
                    project=self,
                    phase=template.phase,
                    label=template.label,
                    description=template.description,
                    confirmation_authority=template.confirmation_authority,
                    client_facing=template.client_facing,
                    default_duration_days=template.default_duration_days,
                    due_date=(
                        self.phase_1_started_at.date() + timedelta(days=template.default_duration_days)
                        if template.phase == 1
                        and self.phase_1_started_at is not None
                        and template.default_duration_days is not None
                        else None
                    ),
                )
                for template in RequirementTemplate.objects.filter(is_active=True).order_by('phase', 'order')
            ])


class PhaseRequirement(models.Model):
    class Status(models.TextChoices):
        PENDING = 'PENDING', 'Pending'
        IN_PROGRESS = 'IN_PROGRESS', 'In Progress'
        COMPLETED = 'COMPLETED', 'Completed'
        NOT_APPLICABLE = 'NOT_APPLICABLE', 'Not Applicable'

    class ConfirmationAuthority(models.TextChoices):
        REP = 'REP', 'Rep'
        MANAGER = 'MANAGER', 'Manager'

    project = models.ForeignKey(
        Project,
        on_delete=models.CASCADE,
        related_name='requirements',
    )
    phase = models.PositiveSmallIntegerField(validators=[MinValueValidator(1), MaxValueValidator(3)])
    label = models.CharField(max_length=255)
    description = models.TextField(blank=True)
    status = models.CharField(max_length=14, choices=Status.choices, default=Status.PENDING)
    notes = models.TextField(blank=True)
    confirmation_authority = models.CharField(
        max_length=8,
        choices=ConfirmationAuthority.choices,
        default=ConfirmationAuthority.REP,
    )
    client_facing = models.BooleanField(default=False)
    # Copied from RequirementTemplate.default_duration_days at generation;
    # used to calculate due_date once this task's phase starts (see
    # ProjectSerializer._record_phase_start). Not itself exposed via the API.
    default_duration_days = models.PositiveIntegerField(null=True, blank=True)
    due_date = models.DateField(null=True, blank=True)
    committed_date = models.DateField(null=True, blank=True)
    updated_by = models.ForeignKey(
        User,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='updated_requirements',
    )
    updated_at = models.DateTimeField(auto_now=True)
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
    def is_confirmed_complete(self):
        if self.status != self.Status.COMPLETED:
            return False
        if self.confirmation_authority == self.ConfirmationAuthority.MANAGER:
            return self.confirmed_by_id is not None
        return True

    @property
    def effective_due_date(self):
        # Whichever commitment is sooner counts as the one to track against.
        dates = [d for d in (self.due_date, self.committed_date) if d is not None]
        return min(dates) if dates else None

    @property
    def is_overdue(self):
        effective = self.effective_due_date
        if effective is None or self.status == self.Status.NOT_APPLICABLE or self.is_confirmed_complete:
            return False
        return effective < timezone.localdate()

    @property
    def completed_late(self):
        effective = self.effective_due_date
        if effective is None or not self.is_confirmed_complete:
            return False
        # confirmed_at is the more precise completion timestamp when this
        # task needed manager confirmation; updated_at is the best available
        # signal otherwise (there's no dedicated "completed_at" field).
        completed_at = self.confirmed_at or self.updated_at
        return completed_at.date() > effective


class ApprovalRequest(models.Model):
    class RequestType(models.TextChoices):
        ARCHIVE_LEAD = 'ARCHIVE_LEAD', 'Archive Lead'
        PHASE_1_SIGNOFF = 'PHASE_1_SIGNOFF', 'Phase 1 Signoff'
        PHASE_2_SIGNOFF = 'PHASE_2_SIGNOFF', 'Phase 2 Signoff'
        PHASE_3_SIGNOFF = 'PHASE_3_SIGNOFF', 'Phase 3 Signoff'
        STATUS_OVERRIDE = 'STATUS_OVERRIDE', 'Status Override'

    # Request types that target a Lead directly, rather than a Project (the
    # phase sign-off types). Used both for creation validation here and by
    # ApprovalRequestSerializer.validate.
    LEAD_TARGETED_TYPES = {RequestType.ARCHIVE_LEAD, RequestType.STATUS_OVERRIDE}

    class Status(models.TextChoices):
        PENDING = 'PENDING', 'Pending'
        APPROVED = 'APPROVED', 'Approved'
        REJECTED = 'REJECTED', 'Rejected'

    request_type = models.CharField(max_length=20, choices=RequestType.choices)
    # Only meaningful for STATUS_OVERRIDE requests -- the status a SALES_REP
    # is asking to pin the lead to.
    requested_status = models.CharField(max_length=8, choices=Lead.Status.choices, null=True, blank=True)
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


def apply_cold_lead_status():
    """The scheduled "cold lead" job (see crm/management/commands/apply_cold_lead_status.py):
    any HOT lead that's gone stale beyond the configured threshold turns
    COLD -- except a lead with an active manual status_override, which takes
    precedence and is left untouched. Returns how many leads were flipped.
    """
    cold_lead_days = SystemSettings.load().cold_lead_days
    cutoff = timezone.now() - timedelta(days=cold_lead_days)
    return Lead.objects.filter(
        status=Lead.Status.HOT,
        status_override__isnull=True,
        last_activity_at__lt=cutoff,
    ).update(status=Lead.Status.COLD)
