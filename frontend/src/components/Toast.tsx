import { useState, useEffect } from 'react';
import { X, CheckCircle, AlertCircle, Info, AlertTriangle } from 'lucide-react';

export type ToastType = 'success' | 'error' | 'warning' | 'info';

export interface Toast {
  id: string;
  type: ToastType;
  title: string;
  message: string;
  duration?: number;
  action?: {
    label: string;
    onClick: () => void;
  };
}

interface ToastProps {
  toast: Toast;
  onClose: (id: string) => void;
}

const ToastComponent = ({ toast, onClose }: ToastProps) => {
  const [isVisible, setIsVisible] = useState(false);
  const [isExiting, setIsExiting] = useState(false);

  useEffect(() => {
    // Trigger animation after mount
    setTimeout(() => setIsVisible(true), 10);

    // Auto-close after duration
    if (toast.duration && toast.duration > 0) {
      const timer = setTimeout(() => {
        handleClose();
      }, toast.duration);

      return () => clearTimeout(timer);
    }
  }, [toast.duration]);

  const handleClose = () => {
    setIsExiting(true);
    setTimeout(() => {
      onClose(toast.id);
    }, 300);
  };

  const getIcon = () => {
    switch (toast.type) {
      case 'success':
        return <CheckCircle className="h-5 w-5 text-green-500" />;
      case 'error':
        return <AlertCircle className="h-5 w-5 text-red-500" />;
      case 'warning':
        return <AlertTriangle className="h-5 w-5 text-yellow-500" />;
      case 'info':
      default:
        return <Info className="h-5 w-5 text-blue-500" />;
    }
  };

  const getStyles = () => {
    const baseStyles = "border-l-4 shadow-lg";
    switch (toast.type) {
      case 'success':
        return `${baseStyles} bg-green-50 dark:bg-green-900/20 border-green-500`;
      case 'error':
        return `${baseStyles} bg-red-50 dark:bg-red-900/20 border-red-500`;
      case 'warning':
        return `${baseStyles} bg-yellow-50 dark:bg-yellow-900/20 border-yellow-500`;
      case 'info':
      default:
        return `${baseStyles} bg-blue-50 dark:bg-blue-900/20 border-blue-500`;
    }
  };

  const getTextColor = () => {
    switch (toast.type) {
      case 'success':
        return 'text-green-800 dark:text-green-200';
      case 'error':
        return 'text-red-800 dark:text-red-200';
      case 'warning':
        return 'text-yellow-800 dark:text-yellow-200';
      case 'info':
      default:
        return 'text-blue-800 dark:text-blue-200';
    }
  };

  return (
    <div
      className={`
        transform transition-all duration-300 ease-in-out
        ${isVisible && !isExiting ? 'translate-x-0 opacity-100' : 'translate-x-full opacity-0'}
        ${getStyles()}
        rounded-lg p-4 mb-3 max-w-md w-full
      `}
    >
      <div className="flex items-start">
        <div className="flex-shrink-0">
          {getIcon()}
        </div>
        <div className="ml-3 flex-1">
          <h3 className={`text-sm font-medium ${getTextColor()}`}>
            {toast.title}
          </h3>
          <p className={`text-sm mt-1 ${getTextColor()} opacity-75`}>
            {toast.message}
          </p>
          {toast.action && (
            <div className="mt-2">
              <button
                onClick={toast.action.onClick}
                className={`text-sm font-medium underline hover:no-underline ${getTextColor()}`}
              >
                {toast.action.label}
              </button>
            </div>
          )}
        </div>
        <div className="ml-4 flex-shrink-0">
          <button
            onClick={handleClose}
            aria-label={`Dismiss ${toast.type} notification: ${toast.title}`}
            className={`inline-flex rounded-md p-1.5 hover:bg-black/10 dark:hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-current ${getTextColor()}`}
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>
  );
};

// Toast Container Component
interface ToastContainerProps {
  toasts: Toast[];
  onClose: (id: string) => void;
}

export const ToastContainer = ({ toasts, onClose }: ToastContainerProps) => {
  return (
    /*
     * aria-live="polite" + aria-atomic="false" lets screen readers announce
     * each toast as it is inserted without interrupting ongoing speech.
     * role="status" is a landmark that AT can navigate to directly.
     */
    <div
      role="status"
      aria-live="polite"
      aria-atomic="false"
      aria-label="Notifications"
      className="fixed top-4 right-4 z-50 space-y-2"
    >
      {toasts.map((toast) => (
        <ToastComponent
          key={toast.id}
          toast={toast}
          onClose={onClose}
        />
      ))}
    </div>
  );
};

// Toast Hook
export const useToast = () => {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const addToast = (toast: Omit<Toast, 'id'>) => {
    const id = Math.random().toString(36).substr(2, 9);
    const newToast: Toast = {
      id,
      duration: 5000, // default 5 seconds
      ...toast,
    };
    setToasts((prev) => [...prev, newToast]);
    return id;
  };

  const removeToast = (id: string) => {
    setToasts((prev) => prev.filter((toast) => toast.id !== id));
  };

  const clearAll = () => {
    setToasts([]);
  };

  // Convenience methods
  const success = (title: string, message: string, options?: Partial<Toast>) => {
    return addToast({ type: 'success', title, message, ...options });
  };

  const error = (title: string, message: string, options?: Partial<Toast>) => {
    return addToast({ type: 'error', title, message, ...options });
  };

  const warning = (title: string, message: string, options?: Partial<Toast>) => {
    return addToast({ type: 'warning', title, message, ...options });
  };

  const info = (title: string, message: string, options?: Partial<Toast>) => {
    return addToast({ type: 'info', title, message, ...options });
  };

  return {
    toasts,
    addToast,
    removeToast,
    clearAll,
    success,
    error,
    warning,
    info,
  };
};

export default ToastComponent; 