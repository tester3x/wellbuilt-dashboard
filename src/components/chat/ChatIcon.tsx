'use client';

interface ChatIconProps {
  onClick: () => void;
  unreadCount: number;
}

export function ChatIcon({ onClick, unreadCount }: ChatIconProps) {
  return (
    <div className="relative">
      <button
        onClick={onClick}
        className="relative p-2 text-[#FFD700] hover:text-[#ffe44d] transition-colors"
        title="Messages"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          className="h-7 w-7"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={1.5}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
          />
        </svg>
      </button>
      {unreadCount > 0 && (
        <span className="absolute -top-1 -right-1 z-[60] bg-red-500 text-white text-xs font-bold rounded-full min-w-[20px] h-[20px] flex items-center justify-center px-1 pointer-events-none">
          {unreadCount > 99 ? '99+' : unreadCount}
        </span>
      )}
    </div>
  );
}
