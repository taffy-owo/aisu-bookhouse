import { apiRequest } from '../../../shared/api';

export type Invitation = {
  code: string;
  created_at: string;
  id: string;
  invitee_user_id: string | null;
  inviter_user_id: string;
  status: 'available' | 'used' | 'revoked';
  used_at: string | null;
};

export type InvitationQuota = {
  can_create: boolean;
  invitation: Invitation | null;
  remaining: number | null;
};

export async function getInvitationQuota(signal?: AbortSignal): Promise<InvitationQuota> {
  return apiRequest<InvitationQuota>('/invitations/me', { signal });
}

export async function createInvitation(signal?: AbortSignal): Promise<Invitation> {
  return apiRequest<Invitation>('/invitations/me', { method: 'POST', signal });
}
