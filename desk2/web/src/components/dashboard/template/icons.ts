// The icons a dashboard spec or feed may name (shared/project-dashboard.ts ICONS), drawn from the window's one icon set.
import type { Component } from 'vue'
import { Bot, Bug, ChartColumn, CircleCheck, Clock, DollarSign, Globe, Hand, LayoutGrid, ListTodo, Mail, Star, TriangleAlert, UserPlus, Users, Zap } from '@lucide/vue'
import type { IconName } from '@shared/project-dashboard'

export const ICON: Record<IconName, Component> = {
  users: Users,
  'user-plus': UserPlus,
  mail: Mail,
  hand: Hand,
  bug: Bug,
  bot: Bot,
  globe: Globe,
  list: ListTodo,
  chart: ChartColumn,
  clock: Clock,
  alert: TriangleAlert,
  check: CircleCheck,
  star: Star,
  money: DollarSign,
  bolt: Zap,
  apps: LayoutGrid
}
