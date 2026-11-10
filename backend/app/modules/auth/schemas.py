from pydantic import BaseModel, EmailStr, Field

from app.modules.users.schemas import UserPublic


class LoginRequest(BaseModel):
    # Deliberately NOT EmailStr: the bootstrap admin account (and existing rows)
    # may use reserved domains like admin@aisu.local, which email-validator
    # rejects; login must keep accepting whatever is stored in the database.
    email: str = Field(max_length=320)
    password: str = Field(max_length=256)


class RegisterRequest(BaseModel):
    email: EmailStr = Field(max_length=320)
    invitation_code: str = Field(max_length=64)
    nickname: str = Field(max_length=80)
    password: str = Field(max_length=256)


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserPublic


class OAuthProvidersResponse(BaseModel):
    google: bool
    discord: bool


class OAuthTicketRequest(BaseModel):
    ticket: str = Field(min_length=20, max_length=256)


class UpdateProfileRequest(BaseModel):
    nickname: str = Field(max_length=80)


class ChangePasswordRequest(BaseModel):
    current_password: str = Field(max_length=256)
    new_password: str = Field(max_length=256)

