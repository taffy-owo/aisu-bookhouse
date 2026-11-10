import type { ComponentPropsWithRef, ReactNode } from 'react';
import { getButtonClassName, type ButtonVariant } from './buttonStyles';

interface ButtonProps extends ComponentPropsWithRef<'button'> {
  icon?: ReactNode;
  variant?: ButtonVariant;
}

export function Button({ children, className, icon, type = 'button', variant = 'primary', ...props }: ButtonProps) {
  return (
    <button className={getButtonClassName({ className, variant })} type={type} {...props}>
      {icon}
      {children}
    </button>
  );
}
