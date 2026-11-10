import type { ReactNode } from 'react';
import { Link, type LinkProps } from 'react-router-dom';
import { getButtonClassName, type ButtonVariant } from './buttonStyles';

interface LinkButtonProps extends LinkProps {
  icon?: ReactNode;
  variant?: ButtonVariant;
}

export function LinkButton({ children, className, icon, variant = 'primary', ...props }: LinkButtonProps) {
  return (
    <Link className={getButtonClassName({ className, variant })} {...props}>
      {icon}
      {children}
    </Link>
  );
}
