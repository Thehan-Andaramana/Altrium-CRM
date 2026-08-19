from rest_framework.permissions import SAFE_METHODS, BasePermission

from .models import User

FULL_ACCESS_ROLES = {
    User.Role.SALES_MANAGER,
    User.Role.EXECUTIVE_MANAGER,
    User.Role.SYSTEM_ADMIN,
}


class RoleBasedAccess(BasePermission):
    """
    SALES_REP: full access, but only to records they own / are assigned to.
    SALES_MANAGER, EXECUTIVE_MANAGER, SYSTEM_ADMIN: full access to all records.
    DELIVERY_LEAD: read-only access to all records.
    """

    def has_permission(self, request, view):
        role = request.user.role
        if role == User.Role.DELIVERY_LEAD:
            return request.method in SAFE_METHODS
        return True

    def has_object_permission(self, request, view, obj):
        role = request.user.role
        if role == User.Role.DELIVERY_LEAD:
            return request.method in SAFE_METHODS
        if role in FULL_ACCESS_ROLES:
            return True
        if role == User.Role.SALES_REP:
            return (
                getattr(obj, 'owner_id', None) == request.user.id
                or getattr(obj, 'assigned_to_id', None) == request.user.id
            )
        return False
