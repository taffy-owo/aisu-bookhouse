from fastapi import APIRouter, Depends, HTTPException, status

from app.core.dependencies import get_current_user, get_invitation_repository
from app.modules.invitations.repository import InvitationRepository
from app.modules.invitations.schemas import InvitationPublic, InvitationQuotaPublic
from app.modules.invitations.service import create_invitation_for_user, get_invitation_quota, to_public
from app.modules.users.domain import User

router = APIRouter(tags=["invitations"])


@router.get("/me", response_model=InvitationQuotaPublic)
def get_my_invitation(
    current_user: User = Depends(get_current_user),
    invitation_repository: InvitationRepository = Depends(get_invitation_repository),
) -> InvitationQuotaPublic:
    return get_invitation_quota(current_user, invitation_repository)


@router.post("/me", response_model=InvitationPublic)
def create_my_invitation(
    current_user: User = Depends(get_current_user),
    invitation_repository: InvitationRepository = Depends(get_invitation_repository),
) -> InvitationPublic:
    try:
        invitation = create_invitation_for_user(current_user, invitation_repository)
    except ValueError as error:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(error)) from error

    return to_public(invitation)
