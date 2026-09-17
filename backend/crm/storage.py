from django.conf import settings
from django.core.files.storage import FileSystemStorage


class PrivateAttachmentStorage(FileSystemStorage):
    """
    Backs TaskAttachment.file. Deliberately outside MEDIA_ROOT -- these are
    client-confidential documents, only ever reached through the
    authenticated download endpoint (see views.TaskAttachmentViewSet.download).

    A subclass with a settings-driven default location, not a pre-built
    instance, specifically so Django's migration writer serializes this as a
    bare class reference (crm.storage.PrivateAttachmentStorage) instead of
    baking today's resolved, machine-specific PRIVATE_MEDIA_ROOT path into
    the migration file -- passing an already-instantiated FileSystemStorage
    object as a FileField's `storage=` does exactly that.
    """

    def __init__(self, *args, **kwargs):
        kwargs.setdefault('location', settings.PRIVATE_MEDIA_ROOT)
        super().__init__(*args, **kwargs)

    def url(self, name):
        # FileSystemStorage.url() falls back to settings.MEDIA_URL when
        # base_url is None rather than raising -- passing base_url=None
        # does *not* disable URL generation the way it might look like it
        # should. Overriding outright is the only way to guarantee nothing
        # ever hands back a (bogus, since the file isn't actually under
        # MEDIA_ROOT) public URL for one of these files.
        raise NotImplementedError('TaskAttachment files have no public URL -- use the download endpoint.')
