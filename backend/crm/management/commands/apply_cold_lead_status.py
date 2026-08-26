from django.core.management.base import BaseCommand

from crm.models import apply_cold_lead_status


class Command(BaseCommand):
    help = (
        'Flips HOT leads whose last activity has gone stale beyond the configured '
        'cold-lead threshold to COLD, skipping any lead with an active manual status override.'
    )

    def handle(self, *args, **options):
        count = apply_cold_lead_status()
        self.stdout.write(self.style.SUCCESS(f'Marked {count} lead(s) COLD.'))
