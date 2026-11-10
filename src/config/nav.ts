import { BookOpen, FileText, Globe2, Home, Languages, Settings, UploadCloud, UserRound } from 'lucide-react';
import { ROUTES } from './routes';

export const MAIN_NAV_ITEMS = [
  { icon: Home, label: '首页', path: ROUTES.home },
  { icon: BookOpen, label: '书架', path: ROUTES.library },
  { icon: Languages, label: '日文', path: ROUTES.japanese },
  { icon: Globe2, label: '公共书库', path: ROUTES.publicLibrary },
  { icon: UploadCloud, label: '上传', path: ROUTES.upload },
] as const;

export const SIDEBAR_BOTTOM_NAV_ITEMS = [
  { icon: UserRound, label: '我的', path: ROUTES.profile },
  { icon: FileText, label: 'API 文档', path: ROUTES.apiDocs },
  { icon: Settings, label: '设置', path: ROUTES.settings },
] as const;

export const MOBILE_NAV_ITEMS = [
  { icon: Home, label: '首页', path: ROUTES.home },
  { icon: BookOpen, label: '书架', path: ROUTES.library },
  { icon: Languages, label: '日文', path: ROUTES.japanese },
  { icon: UploadCloud, label: '上传', path: ROUTES.upload },
  { icon: Globe2, label: '公共', path: ROUTES.publicLibrary },
] as const;
