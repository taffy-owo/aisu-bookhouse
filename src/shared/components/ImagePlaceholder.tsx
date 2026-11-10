import { ImageIcon, Sparkles } from 'lucide-react';
import { cn } from '../utils/cn';

interface ImagePlaceholderProps {
  className?: string;
  label?: string;
  mood?: 'sakura' | 'night' | 'sky' | 'cream' | 'forest' | 'violet';
}

const moodClass: Record<NonNullable<ImagePlaceholderProps['mood']>, string> = {
  cream: 'from-[#FFF6E9] via-[#EAD9C0] to-[#D7A99C] text-[#59483D]',
  forest: 'from-[#E9F2E7] via-[#9BB29A] to-[#576B5D] text-[#314238]',
  night: 'from-[#1D1B22] via-[#343248] to-[#FF8B8B] text-white',
  sakura: 'from-[#FDECEF] via-[#F7D6DE] to-[#8297B9] text-plum',
  sky: 'from-[#DDEEFF] via-[#AFCDEB] to-[#F9D9DD] text-[#314052]',
  violet: 'from-[#F5E8FF] via-[#CABBE7] to-[#93A7D9] text-[#42384F]',
};

export function ImagePlaceholder({ className, label = '图片', mood = 'sakura' }: ImagePlaceholderProps) {
  return (
    <div className={cn('relative overflow-hidden bg-gradient-to-br', moodClass[mood], className)}>
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_20%_20%,rgba(255,255,255,.45),transparent_22%),radial-gradient(circle_at_80%_30%,rgba(255,255,255,.25),transparent_24%)]" />
      <div className="absolute -right-8 -top-8 h-28 w-28 rounded-full bg-white/25 blur-xl" />
      <div className="absolute bottom-0 left-0 right-0 h-1/2 bg-gradient-to-t from-black/20 to-transparent" />
      <div className="relative flex h-full min-h-[160px] flex-col justify-between p-5">
        <Sparkles className="h-5 w-5 opacity-70" />
        <div>
          <ImageIcon className="mb-3 h-7 w-7 opacity-70" />
          <div className="font-display text-xl font-semibold">{label}</div>
          <div className="mt-1 text-xs opacity-70">等待真实图片资源</div>
        </div>
      </div>
    </div>
  );
}
