"""A request's browser opens beyond the screen's top-left and never keeps the keyboard.

Chrome takes the foreground for its new window. An off-screen window holding it would
swallow the person's typing, so the foreground goes straight back to what had it.
"""
import asyncio
import os

# Chrome keeps a command-line position as given, so the window opens beyond every monitor.
SPOT = (-20000, -20000)
# Off-screen counts as covered, and Chrome would otherwise pause or slow the page as hidden.
ARGS = [f'--window-position={SPOT[0]},{SPOT[1]}',
    '--disable-features=CalculateNativeWinOcclusion', '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding', '--disable-background-timer-throttling']


class FocusReturn:
    """Hand the foreground back whenever a window at the off-screen spot takes it."""
    def __init__(self, windows=None):
        self.windows = windows if windows is not None else _Windows() if os.name == 'nt' else None
        self.previous = None
        self.step()

    def step(self):
        current = self.windows.foreground() if self.windows else None
        if not current:
            return
        if self.windows.position(current) != SPOT:
            self.previous = current
        elif self.previous and self.windows.exists(self.previous):
            self.windows.activate(self.previous, current)

    async def watch(self, interval=.05):
        while self.windows:
            self.step()
            await asyncio.sleep(interval)


class _Windows:
    def __init__(self):
        import ctypes
        from ctypes import wintypes
        user32, kernel32 = ctypes.WinDLL('user32'), ctypes.WinDLL('kernel32')
        user32.GetForegroundWindow.restype = wintypes.HWND
        user32.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
        user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
        user32.GetWindowThreadProcessId.restype = wintypes.DWORD
        user32.IsWindow.argtypes = [wintypes.HWND]
        user32.SetForegroundWindow.argtypes = [wintypes.HWND]
        user32.AttachThreadInput.argtypes = [wintypes.DWORD, wintypes.DWORD, wintypes.BOOL]
        self.ctypes, self.rect, self.user32, self.kernel32 = ctypes, wintypes.RECT, user32, kernel32

    def foreground(self):
        return self.user32.GetForegroundWindow()

    def position(self, window):
        rect = self.rect()
        self.user32.GetWindowRect(window, self.ctypes.byref(rect))
        return rect.left, rect.top

    def exists(self, window):
        return bool(self.user32.IsWindow(window))

    def activate(self, window, holder):
        # Sharing the holder's input state lets this background process give the foreground back.
        own, theirs = self.kernel32.GetCurrentThreadId(), self.user32.GetWindowThreadProcessId(holder, None)
        joined = self.user32.AttachThreadInput(own, theirs, True)
        try:
            self.user32.SetForegroundWindow(window)
        finally:
            if joined:
                self.user32.AttachThreadInput(own, theirs, False)
