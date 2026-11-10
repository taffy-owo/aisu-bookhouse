import { useEffect, useRef, useState } from 'react';
import { useTheme } from '../theme';

interface Petal {
  x: number;
  y: number;
  r: number;
  d: number;
  rotation: number;
  rotationSpeed: number;
  sway: number;
  swaySpeed: number;
  color: string;
}

interface SakuraBackgroundProps {
  /** Number of drifting petals. Lower it for a sparser, calmer field. */
  count?: number;
  /** Override the canvas class (opacity / z-index) for a softer look. */
  className?: string;
}

export function SakuraBackground({ count = 28, className }: SakuraBackgroundProps = {}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const { theme } = useTheme();
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined;
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const updateMotion = () => setPrefersReducedMotion(motion.matches);
    motion.addEventListener('change', updateMotion);
    return () => motion.removeEventListener('change', updateMotion);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animationFrameId: number | undefined;
    let previousTimestamp: number | undefined;
    // Render at device resolution (capped at 2x) so petals stay crisp on
    // Retina/HiDPI screens; physics keeps working in CSS-pixel space.
    let width = window.innerWidth;
    let height = window.innerHeight;
    const resizeCanvas = () => {
      width = window.innerWidth;
      height = window.innerHeight;
      const scale = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(4_000_000 / Math.max(1, width * height)));
      canvas.width = Math.round(width * scale);
      canvas.height = Math.round(height * scale);
      ctx.setTransform(scale, 0, 0, scale, 0, 0);
    };
    resizeCanvas();

    // Dynamic color palette based on active theme
    const getPetalColors = (isDark: boolean) => {
      return isDark
        ? [
            // Night mode uses moonlit neutrals instead of pink so petals never
            // read as a light-theme layer left behind during navigation.
            'rgba(174, 190, 218, 0.14)',
            'rgba(205, 193, 176, 0.11)',
            'rgba(136, 157, 190, 0.12)',
            'rgba(224, 211, 190, 0.09)',
          ]
        : [
            'rgba(243, 111, 108, 0.32)', // Accent Rose
            'rgba(255, 192, 203, 0.45)', // Pink
            'rgba(255, 224, 229, 0.55)', // Light Sakura
            'rgba(249, 212, 214, 0.50)', // Soft Cream Pink
          ];
    };

    const colors = getPetalColors(theme === 'dark');

    const petals: Petal[] = [];
    const maxPetals = count; // Caller-tunable density (defaults to 28)

    // Initialize petals
    for (let i = 0; i < maxPetals; i++) {
      petals.push(createPetal(true));
    }

    function createPetal(randomY = false): Petal {
      const size = Math.random() * 8 + 5;
      return {
        x: Math.random() * width,
        y: randomY ? Math.random() * height : -20,
        r: size,
        d: Math.random() * 0.6 + 0.3, // Falling speed factor
        rotation: Math.random() * Math.PI * 2,
        rotationSpeed: (Math.random() * 0.02 - 0.01) * 1.5,
        sway: Math.random() * Math.PI * 2,
        swaySpeed: Math.random() * 0.01 + 0.005,
        color: colors[Math.floor(Math.random() * colors.length)],
      };
    }

    function drawPetal(p: Petal) {
      if (!ctx) return;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rotation);
      ctx.beginPath();
      // Draw realistic leaf/petal shape using bezier curves
      ctx.moveTo(0, -p.r);
      ctx.bezierCurveTo(p.r * 0.7, -p.r, p.r * 0.7, p.r * 0.4, 0, p.r);
      ctx.bezierCurveTo(-p.r * 0.7, p.r * 0.4, -p.r * 0.7, -p.r, 0, -p.r);
      ctx.fillStyle = p.color;
      
      // In dark mode, add a subtle glowing blur shadow
      if (theme === 'dark') {
        ctx.shadowBlur = 2;
        ctx.shadowColor = p.color;
      }
      
      ctx.fill();
      ctx.restore();
    }

    function update(timestamp: number) {
      // Keep the original 60 Hz pace on every display. A stalled frame must
      // not fast-forward petals across the screen when drawing resumes.
      const elapsed = previousTimestamp === undefined ? 0 : Math.min(50, Math.max(0, timestamp - previousTimestamp));
      const frameScale = elapsed / (1000 / 60);
      previousTimestamp = timestamp;
      ctx?.clearRect(0, 0, width, height);

      for (let i = 0; i < petals.length; i++) {
        const p = petals[i];

        // Slowly fall down and drift to the right
        p.y += (p.d * 1.2 + 0.4) * frameScale;
        p.x += (Math.sin(p.sway) * 0.5 + 0.6) * frameScale; // Sway left and right + drift rightward

        p.rotation += p.rotationSpeed * frameScale;
        p.sway += p.swaySpeed * frameScale;

        // If petal falls off screen, reset to top
        if (p.y > height + 20 || p.x > width + 20 || p.x < -20) {
          petals[i] = createPetal(false);
        }

        drawPetal(p);
      }

      animationFrameId = requestAnimationFrame(update);
    }

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        if (animationFrameId !== undefined) cancelAnimationFrame(animationFrameId);
        animationFrameId = undefined;
        previousTimestamp = undefined;
      } else if (animationFrameId === undefined) {
        update(performance.now());
      }
    };
    handleVisibilityChange();

    window.addEventListener('resize', resizeCanvas);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      if (animationFrameId !== undefined) cancelAnimationFrame(animationFrameId);
      window.removeEventListener('resize', resizeCanvas);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      // Clear the backing store when the theme effect is replaced. Without
      // this, the previous palette can remain visible for a frame while React
      // reuses the fixed canvas during a route/theme change.
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.restore();
    };
  }, [theme, count, prefersReducedMotion]);

  if (prefersReducedMotion) {
    return null;
  }

  return (
    <canvas
      aria-hidden="true"
      ref={canvasRef}
      className={
        className ??
        'pointer-events-none fixed inset-0 z-0 h-full w-full opacity-75 transition-opacity duration-1000 dark:opacity-60'
      }
    />
  );
}
