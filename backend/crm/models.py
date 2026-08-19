from django.contrib.auth.models import AbstractUser
from django.db import models


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

    def __str__(self):
        return f'{self.company} lead ({self.status})'


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
        related_name='deals',
    )
    stage = models.CharField(
        max_length=16,
        choices=Stage.choices,
        default=Stage.NEW_LEAD,
    )
    value = models.DecimalField(max_digits=12, decimal_places=2)
    assigned_to = models.ForeignKey(
        User,
        on_delete=models.CASCADE,
        related_name='assigned_deals',
    )

    def __str__(self):
        return f'{self.company} - {self.get_stage_display()}'


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
