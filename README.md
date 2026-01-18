Monorepo layout (web + mobile) with shared business logic

Structure:
/apps
  /web    - React web app (uses React Router)
  /mobile - React Native / Expo app (uses React Navigation)
/shared   - Shared logic: hooks, services, utils, types

Guidelines:
- Keep UI components in `apps/web` and `apps/mobile`.
- Put all platform-agnostic logic (api clients, hooks, business rules) in `shared/`.
- Use adapters when you need platform-specific behavior (storage, notifications).

Example: both web and mobile import hooks from `shared/hooks` to reuse logic.
