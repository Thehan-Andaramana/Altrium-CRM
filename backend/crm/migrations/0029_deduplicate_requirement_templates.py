from django.db import migrations


def deduplicate_templates(apps, schema_editor):
    """
    Remove the duplicate requirement templates the phase renumbering left
    behind.

    When Phase 4 was introduced (migration 0019) the template set was
    reseeded under the new numbering, but the old rows stayed: every one of
    them is inactive, carries no tasks, and shares its label with an active
    template -- some in the phase they used to sit in, some in the very same
    phase. The settings page showed each of those labels twice, one live and
    one dead.

    The active row is the one kept, and only an inactive row with an active
    twin is ever deleted -- so this can neither remove a template that is in
    use nor collapse two templates that a manager deliberately created.

    Two things move across before a row goes:

    * Tasks. PhaseRequirement.template is SET_NULL, so a delete wouldn't
      take any tasks with it, but it would cut their link back to the
      template they came from. They are repointed at the kept row instead.
    * Form fields. TaskFormField.template is CASCADE, so a discarded row's
      fields would be deleted with it. Where the kept row has none of its
      own, they are moved over rather than lost -- a form attached to a
      template should survive the template being tidied up.
    """
    RequirementTemplate = apps.get_model('crm', 'RequirementTemplate')
    PhaseRequirement = apps.get_model('crm', 'PhaseRequirement')
    TaskFormField = apps.get_model('crm', 'TaskFormField')

    # The active row per label is what everything else folds into. Ordered
    # by id so the choice is deterministic where a label somehow has two.
    keepers = {}
    for template in RequirementTemplate.objects.filter(is_active=True).order_by('id'):
        keepers.setdefault(template.label, template)

    if not keepers:
        return

    for duplicate in RequirementTemplate.objects.filter(is_active=False).order_by('id'):
        keeper = keepers.get(duplicate.label)
        if keeper is None:
            # An inactive template with no active twin is a real template a
            # manager retired, not a leftover -- left alone.
            continue

        PhaseRequirement.objects.filter(template=duplicate).update(template=keeper)

        if not TaskFormField.objects.filter(template=keeper).exists():
            TaskFormField.objects.filter(template=duplicate).update(template=keeper)

        duplicate.delete()


def noop_reverse(apps, schema_editor):
    """
    Irreversible in effect: the removed rows were duplicates carrying no
    information the kept ones don't, and nothing records which ones went.
    """


class Migration(migrations.Migration):

    dependencies = [
        ('crm', '0028_reassign_manager_held_leads'),
    ]

    operations = [
        migrations.RunPython(deduplicate_templates, noop_reverse),
    ]
