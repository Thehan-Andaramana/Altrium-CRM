from django.db import migrations, models


def populate_lead_names(apps, schema_editor):
    Lead = apps.get_model('crm', 'Lead')
    for lead in Lead.objects.select_related('company', 'contact').all():
        if lead.contact_id:
            lead.name = f'{lead.company.name} — {lead.contact.name}'
        else:
            lead.name = lead.company.name
        lead.save(update_fields=['name'])


class Migration(migrations.Migration):

    dependencies = [
        ('crm', '0017_phaserequirement_committed_date_and_more'),
    ]

    operations = [
        migrations.AddField(
            model_name='lead',
            name='name',
            field=models.CharField(default='', max_length=200),
            preserve_default=False,
        ),
        migrations.RunPython(populate_lead_names, migrations.RunPython.noop),
    ]
