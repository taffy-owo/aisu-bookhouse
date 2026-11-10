import { cn } from '../utils/cn';

interface AnimeSceneProps {
  className?: string;
  dark?: boolean;
}

export function AnimeScene({ className, dark = false }: AnimeSceneProps) {
  return (
    <div
      className={cn(
        'relative h-full min-h-[220px] overflow-hidden',
        dark
          ? 'bg-gradient-to-br from-[#211F27] via-[#4B3948] to-[#F29AA0]'
          : 'bg-gradient-to-br from-[#FFF7F4] via-[#F9DDE0] to-[#D8E5F9]',
        className,
      )}
    >
      <div className="absolute inset-0 opacity-80 [background-image:radial-gradient(circle_at_18%_18%,rgba(255,255,255,.8)_0_2px,transparent_3px),radial-gradient(circle_at_76%_32%,rgba(255,139,150,.34)_0_3px,transparent_4px)] [background-size:40px_40px,58px_58px]" />
      <div className="absolute inset-x-0 bottom-0 h-24 bg-gradient-to-t from-white/[0.38] to-transparent" />
      <div className="absolute left-[22%] top-[15%] h-60 w-36 -rotate-6 rounded-t-full bg-gradient-to-b from-[#30262D] to-[#75515C] opacity-90 shadow-2xl" />
      <div className="absolute left-[29%] top-[31%] h-20 w-20 rounded-full bg-[#FFE1D7] shadow" />
      <div className="absolute left-[17%] bottom-0 h-28 w-48 rounded-t-[80px] bg-white/[0.78]" />
      <div className="absolute right-[18%] top-[14%] h-60 w-36 rotate-6 rounded-t-full bg-gradient-to-b from-[#E9D7D9] to-[#B9B4D8] opacity-95 shadow-2xl" />
      <div className="absolute right-[25%] top-[31%] h-20 w-20 rounded-full bg-[#FFE5DB] shadow" />
      <div className="absolute right-[11%] bottom-0 h-28 w-48 rounded-t-[80px] bg-white/[0.82]" />
      {[...Array(18)].map((_, index) => (
        <span
          className="absolute h-2 w-3 rounded-full bg-[#FF9EA8]/70"
          key={index}
          style={{
            left: `${8 + index * 5}%`,
            top: `${10 + ((index * 17) % 64)}%`,
            transform: `rotate(${index * 31}deg)`,
          }}
        />
      ))}
      <div className="absolute bottom-6 left-6 rounded-full bg-white/[0.88] px-4 py-2 text-sm text-stone-800 shadow-xl">
        下个周末，也一起吧。
      </div>
    </div>
  );
}
