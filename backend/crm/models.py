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

    def __str__(self):
        return self.name

    @property
    def owner_id(self):
        # Lets RoleBasedAccess.has_object_permission scope this exactly like
        # a Company, without a bespoke permission class.
        return self.company.owner_id


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
        return f'{self.company} lead ({self.status})'

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
        if self.outcome == Interaction.Outcome.RESPONDED:
            # QuerySet.update() bypasses Lead.last_activity_at's auto_now, so
            # occurred_at (which may be backdated) sticks instead of "now".
            Lead.objects.filter(pk=self.lead_id).update(
                last_activity_at=self.occurred_at,
                status=Lead.Status.HOT,
            )


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
            PhaseRequirement.objects.bulk_create([
                PhaseRequirement(
                    project=self,
                    phase=template.phase,
                    label=template.label,
                    confirmation_authority=template.confirmation_authority,
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
    status = models.CharField(max_length=14, choices=Status.choices, default=Status.PENDING)
    notes = models.TextField(blank=True)
    confirmation_authority = models.CharField(
        max_length=8,
        choices=ConfirmationAuthority.choices,
        default=ConfirmationAuthority.REP,
    )
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


class ApprovalRequest(models.Model):
    class RequestType(models.TextChoices):
        ARCHIVE_LEAD = 'ARCHIVE_LEAD', 'Archive Lead'
        PHASE_1_SIGNOFF = 'PHASE_1_SIGNOFF', 'Phase 1 Signoff'
        PHASE_2_SIGNOFF = 'PHASE_2_SIGNOFF', 'Phase 2 Signoff'
        PHASE_3_SIGNOFF = 'PHASE_3_SIGNOFF', 'Phase 3 Signoff'

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
        ]

    def __str__(self):
        return f'{self.get_request_type_display()} ({self.status})'

    @property
    def target(self):
        return self.lead or self.project


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
