export type CommentTargetType = 'book' | 'volume';

export type PublicComment = {
  id: string;
  bookId: string;
  userId: string;
  userNickname: string;
  targetType: CommentTargetType;
  targetIndex?: number;
  body: string;
  createdAt: string;
  updatedAt: string;
};
