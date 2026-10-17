import React, { useRef } from 'react';
import { BoxType } from '../types';

interface DataBoxProps {
  type: BoxType;
  label: string;
  unit?: string;
  value?: string;
  valueColor?: string;
  isLargeValue?: boolean;
  unstable?: boolean;
  alarmClass?: string;
  isFocused?: boolean;
  isHercules?: boolean;
  children?: React.ReactNode;
  onLongPress?: () => void;
  onDoubleTap?: () => void;
  onSingleTap?: () => void;
}

export const DataBox: React.FC<DataBoxProps> = ({
  type,
  label,
  unit,
  value,
  valueColor,
  isLargeValue = false,
  unstable = false,
  alarmClass = '',
  isFocused = false,
  isHercules = false,
  children,
  onLongPress,
  onDoubleTap,
  onSingleTap,
}) => {
  const pressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isLongPressActiveRef = useRef(false);
  const lastTapTimeRef = useRef(0);
  const tapTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handlePointerDown = () => {
    isLongPressActiveRef.current = false;
    pressTimerRef.current = setTimeout(() => {
      isLongPressActiveRef.current = true;
      if (onLongPress) onLongPress();
      lastTapTimeRef.current = 0;
    }, 1000);
  };

  const handlePointerUp = () => {
    if (pressTimerRef.current) {
      clearTimeout(pressTimerRef.current);
      pressTimerRef.current = null;
    }
    if (isLongPressActiveRef.current) return;

    const currentTime = Date.now();
    const tapDelay = currentTime - lastTapTimeRef.current;

    if (tapDelay < 300 && tapDelay > 0) {
      if (tapTimeoutRef.current) clearTimeout(tapTimeoutRef.current);
      if (onDoubleTap) onDoubleTap();
      lastTapTimeRef.current = 0;
    } else {
      lastTapTimeRef.current = currentTime;
      tapTimeoutRef.current = setTimeout(() => {
        if (onSingleTap) onSingleTap();
      }, 250);
    }
  };

  const handlePointerLeave = () => {
    if (pressTimerRef.current) {
      clearTimeout(pressTimerRef.current);
      pressTimerRef.current = null;
    }
    isLongPressActiveRef.current = false;
  };

  const boxClasses = [
    'data-box',
    `box-${type}`,
    isFocused ? 'is-focused' : '',
    isHercules ? 'box-hercules' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className={boxClasses}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerLeave={handlePointerLeave}
    >
      <div className="label-row">
        <span className="label" id={type === 'sog' ? 'sog-vmg-label' : type === 'tws' ? 'tws-aws-label' : undefined}>
          {label}
        </span>
        {unit && <span className="unit">{unit}</span>}
      </div>

      {value !== undefined && (
        <span
          className={`${isLargeValue ? 'value-large' : 'value'} ${unstable ? 'unstable-data' : ''} ${alarmClass}`}
          id={type}
          style={valueColor ? { color: valueColor } : undefined}
          dangerouslySetInnerHTML={{ __html: value }}
        />
      )}

      {children}
    </div>
  );
};
