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


class CompanyPermission(BasePermission):
    """
    Like RoleBasedAccess, except SALES_REP gets read access to every company
    (not just ones they own) -- they can open any company read-only, but
    only write to ones they own.
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
            if request.method in SAFE_METHODS:
                return True
            return obj.owner_id == request.user.id
        return False


class ManagementRolePermission(BasePermission):
    """Restricts a view to SALES_MANAGER, EXECUTIVE_MANAGER, and SYSTEM_ADMIN."""

    def has_permission(self, request, view):
        return request.user.role in FULL_ACCESS_ROLES


class ApprovalRequestPermission(BasePermission):
    """
    SALES_REP: may create requests and only read their own.
    Management roles: may read all and PATCH status (approve/reject), but
    never decide a request they submitted themselves.
    """

    def has_permission(self, request, view):
        if view.action == 'create':
            return True
        if request.method in SAFE_METHODS:
            return True
        return request.user.role in FULL_ACCESS_ROLES

    def has_object_permission(self, request, view, obj):
        role = request.user.role
        if request.method in SAFE_METHODS:
            return role in FULL_ACCESS_ROLES or obj.requested_by_id == request.user.id
        # Only PATCH reaches here -- has_permission already blocked everyone
        # else, and the viewset doesn't offer PUT/DELETE.
        return obj.requested_by_id != request.user.id


class SystemSettingsPermission(BasePermission):
    """GET is open to any authenticated user; PATCH is restricted to management roles."""

    MANAGE_ROLES = {
        User.Role.SALES_MANAGER,
        User.Role.EXECUTIVE_MANAGER,
        User.Role.SYSTEM_ADMIN,
    }

    def has_permission(self, request, view):
        if request.method in SAFE_METHODS:
            return True
        return request.user.role in self.MANAGE_ROLES
