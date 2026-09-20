from django.db import migrations
from django.db.models import Count


def reassign_manager_held_leads(apps, schema_editor):
    """
    A lead is carried by a sales rep, never by a manager (see
    LeadSerializer.validate_assigned_to). Before that rule existed a manager
    creating a lead without naming a rep had it assigned to themselves, so
    some rows are held by one.

    Each such lead goes to the owner of its company when that owner is a
    rep -- the person already closest to the account -- and otherwise to
    whichever rep is carrying the fewest leads, so the reassignment spreads
    rather than piling onto one person.

    Lead.assigned_to is not nullable, so "unassign it" isn't available here;
    where there is no rep at all to move a lead to, it is left exactly as it
    was rather than the migration failing. The serializer rule still holds
    from here on, and the next edit to such a lead has to name a rep.
    """
    Lead = apps.get_model('crm', 'Lead')
    User = apps.get_model('crm', 'User')

    stranded = Lead.objects.exclude(assigned_to__role='SALES_REP').select_related('company')
    if not stranded.exists():
        return

    reps = list(User.objects.filter(role='SALES_REP'))
    if not reps:
        return

    # Live count per rep, so leads moved by this migration are weighed in as
    # it goes and the last rep doesn't collect all of them.
    load = {rep.id: 0 for rep in reps}
    for row in (
        Lead.objects.filter(assigned_to__role='SALES_REP')
        .values('assigned_to')
        .annotate(total=Count('id'))
    ):
        if row['assigned_to'] in load:
            load[row['assigned_to']] = row['total']

    rep_ids = {rep.id for rep in reps}

    for lead in stranded:
        owner_id = lead.company.owner_id if lead.company_id else None
        target_id = owner_id if owner_id in rep_ids else min(load, key=load.get)
        lead.assigned_to_id = target_id
        # update() rather than save(): Lead.save() creates a Project for a
        # new lead and this is an existing one, and historical models don't
        # carry that method anyway.
        Lead.objects.filter(pk=lead.pk).update(assigned_to_id=target_id)
        load[target_id] += 1


def noop_reverse(apps, schema_editor):
    """
    Deliberately irreversible in effect: who a lead was assigned to before
    the reassignment isn't recorded anywhere, so there is nothing to put
    back. Reversing the migration simply leaves the new assignments in place.
    """


class Migration(migrations.Migration):

    dependencies = [
        ('crm', '0027_project_board_order'),
    ]

    operations = [
        migrations.RunPython(reassign_manager_held_leads, noop_reverse),
    ]
