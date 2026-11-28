import { useEffect, useRef, useState } from "preact/hooks";
import { useApp } from "../context";
import type { Appointment, BlockedSlot } from "../types";
import { CalendarDays, CalendarRange, Check, ChevronDown, ChevronLeft, ChevronRight, Columns3, Ellipsis, LayoutList, Plus, RectangleVertical, X, Ban, TriangleAlert, Download } from "lucide-preact";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CreateAppointment } from "./create-appointment";
import { cn } from "@/lib/utils";
import { packLanes } from "@/lib/overlap";
import { monthGrid, parseDate, shiftDate, shiftMonth, today, weekOf } from "@/lib/dates";
import { calendarSlotMinutes, formatCalendarTime, formatClock, formatRange, inkOn } from "@/lib/calendar-slot";
import { conflictsFrom, describeConflict, type Conflict } from "@/lib/conflicts";
import { downloadDaySheet } from "@/lib/day-sheet";
import { agendaDays, CALENDAR_VIEWS, rangeLabel, SCHEDULE_DAYS, viewDays, viewStep, type CalendarViewKind } from "@/lib/calendar-views";
import { UNASSIGNED_COLOR } from "@/lib/palette";
import { barberChoice, soloBarber } from "@/lib/solo";
import { useConfirm } from "./confirm-sheet";

const DAY_LETTERS = ["S", "M", "T", "W", "T", "F", "S"];

const VIEW_ICONS: Record<CalendarViewKind, typeof CalendarDays> = {
  schedule: LayoutList,
  day: RectangleVertical,
  "3day": Columns3,
  week: CalendarRange,
};

/** One column of the timeline: a staff member's day, the bookings with no staff, or a whole day. */
interface Column { key: string; date: string; staffId: number | null; name: string; color: string; appointments: Appointment[]; blocked: BlockedSlot[] }

function minutesNow(): number {
  const now = new Date();
  return now.getHours() * 60 + now.getMinutes();
}

const HOURS = Array.from({ length: 14 }, (_, i) => i + 7); // 7 AM to 8 PM

function timeToMinutes(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}

/**
 * Lay a column's appointments and blocked slots out side by side.
 *
 * Blocked time is packed together with the bookings because it competes for the
 * same person: drawing a booking over the top of a lunch break hid the break.
 */
function layOutColumn(
  appointments: Appointment[],
  blocked: BlockedSlot[],
  dayStart: number,
) {
  return packLanes([
    ...blocked.map((b) => ({
      key: `b-${b.id}`, block: b, appointment: null as Appointment | null,
      start: timeToMinutes(b.start_time) - dayStart,
      end: timeToMinutes(b.end_time) - dayStart,
    })),
    ...appointments.map((a) => ({
      key: `a-${a.id}`, block: null as BlockedSlot | null, appointment: a,
      start: timeToMinutes(a.start_time) - dayStart,
      end: timeToMinutes(a.end_time) - dayStart,
    })),
  ]);
}

/** Where a laid-out span sits across the width of its column. */
function laneStyle(lane: number, lanes: number, gap = 4) {
  const width = 100 / lanes;
  return { left: `calc(${lane * width}% + ${gap}px)`, width: `calc(${width}% - ${gap * 2}px)` };
}

function formatHour(h: number): string {
  return formatClock(`${h}:00`);
}

export function CalendarView() {
  const {
    calendarAppointments, calendarBlocked, calendarDate, setCalendarDate,
    calendarView, setCalendarView,
    staffLookup, navigate, deleteBlockedSlot, addBlockedSlot, setError,
  } = useApp();
  const solo = soloBarber(staffLookup);
  const [showViews, setShowViews] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [draftBooking, setDraftBooking] = useState<{ staffId: number | null; date: string; startTime: string } | null>(null);
  const [showBlockForm, setShowBlockForm] = useState(false);
  const [pickedBlockStaff, setBlockStaff] = useState("");
  const blockStaff = barberChoice(staffLookup, pickedBlockStaff);
  const [blockStart, setBlockStart] = useState("12:00");
  const [blockEnd, setBlockEnd] = useState("13:00");
  const [blockReason, setBlockReason] = useState("");
  const [blockConflicts, setBlockConflicts] = useState<Conflict[] | null>(null);
  // Phones: the month to show in the open month picker, or null when it is closed.
  const [monthShown, setMonthShown] = useState<string | null>(null);
  const [showMenu, setShowMenu] = useState(false);
  const [ask, sheet] = useConfirm();
  const unblock = (block: BlockedSlot) => ask({
    title: "Remove this blocked time?",
    text: `${block.reason || "Blocked"}, ${block.start_time} to ${block.end_time}. Clients can book this time again.`,
    action: "Remove", run: () => deleteBlockedSlot(block.id),
  });
  const [nowMinutes, setNowMinutes] = useState(minutesNow);
  const scroller = useRef<HTMLDivElement>(null);
  const swipeFrom = useRef<{ x: number; y: number } | null>(null);

  const dateObj = parseDate(calendarDate);
  const todayStr = today();

  const chooseDate = (date: string) => {
    setCalendarDate(date);
    setBlockConflicts(null);
  };
  const shiftDay = (delta: number) => chooseDate(shiftDate(calendarDate, delta));
  const days = viewDays(calendarView, calendarDate);
  const manyDays = calendarView === "3day" || calendarView === "week";
  const step = viewStep(calendarView);
  const ViewIcon = VIEW_ICONS[calendarView];
  const chooseView = (view: CalendarViewKind) => {
    setCalendarView(view);
    setShowViews(false);
    setBlockConflicts(null);
  };
  const openDay = (date: string) => {
    chooseDate(date);
    setCalendarView("day");
  };
  // One barber: every booking is theirs, so every booking gets their color.
  const colorOf = (staffId: number | null | undefined) =>
    solo?.color ?? staffLookup.find((s) => s.id === staffId)?.color ?? UNASSIGNED_COLOR;

  const dayStart = HOURS[0] * 60;
  const dayEnd = (HOURS[HOURS.length - 1] + 1) * 60;
  const totalMinutes = dayEnd - dayStart;
  const hourHeight = 64;
  const totalHeight = (totalMinutes / 60) * hourHeight;

  const openBlankBooking = () => {
    setDraftBooking(null);
    setShowCreate(true);
  };

  const openSlotBooking = (staffId: number | null, date: string, column: HTMLDivElement, clientY: number) => {
    const rect = column.getBoundingClientRect();
    const minutes = calendarSlotMinutes(clientY - rect.top, rect.height, dayStart, dayEnd);
    setDraftBooking({ staffId, date, startTime: formatCalendarTime(minutes) });
    setShowCreate(true);
  };

  const closeBooking = () => {
    setShowCreate(false);
    setDraftBooking(null);
  };

  const handleAddBlock = async (allowConflict = false) => {
    if (!blockStaff) return;
    setBlockConflicts(null);
    try {
      await addBlockedSlot({
        staff_id: parseInt(blockStaff),
        blocked_date: calendarDate,
        start_time: blockStart,
        end_time: blockEnd,
        reason: blockReason,
        ...(allowConflict ? { allow_conflict: true } : {}),
      });
      setError(null);
      setShowBlockForm(false);
      setBlockReason("");
    } catch (err) {
      const clashes = conflictsFrom(err);
      if (clashes) setBlockConflicts(clashes);
      else setError((err as Error).message);
    }
  };

  const clearBlockConflicts = () => setBlockConflicts(null);

  const toggleBlockForm = () => {
    setShowBlockForm(!showBlockForm);
    setBlockConflicts(null);
    setShowMenu(false);
  };
  const saveDaySheet = () => {
    // The sheet is for the picked day, even when more days are on screen.
    downloadDaySheet(
      calendarDate,
      calendarAppointments.filter((a) => a.scheduled_date === calendarDate),
      calendarBlocked.filter((b) => b.blocked_date === calendarDate),
    );
    setShowMenu(false);
  };

  const isToday = calendarDate === todayStr;
  const nowInHours = nowMinutes >= dayStart && nowMinutes <= dayEnd;
  const topOf = (minutes: number) => ((minutes - dayStart) / totalMinutes) * totalHeight;

  // Keep the "now" line moving.
  useEffect(() => {
    const timer = window.setInterval(() => setNowMinutes(minutesNow()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  // Open each day near the useful part: an hour before now today, 8 AM on other days.
  useEffect(() => {
    const box = scroller.current;
    if (!box) return;
    const from = isToday && calendarView === "day" ? Math.max(minutesNow() - 60, dayStart) : 8 * 60;
    box.scrollTop = calendarView === "schedule" ? 0 : Math.max(0, topOf(Math.min(from, dayEnd)));
  }, [calendarDate, calendarView]);

  const onDay = calendarAppointments.filter((a) => a.scheduled_date === calendarDate);
  const blockedOnDay = calendarBlocked.filter((b) => b.blocked_date === calendarDate);
  let columns: Column[];
  if (manyDays) {
    // Several days: one column for each day, with everyone's bookings in it.
    columns = days.map((date) => ({
      key: `d-${date}`, date, staffId: solo?.id ?? null, color: UNASSIGNED_COLOR,
      name: parseDate(date).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" }),
      appointments: calendarAppointments.filter((a) => a.scheduled_date === date),
      blocked: calendarBlocked.filter((b) => b.blocked_date === date),
    }));
  } else if (solo) {
    // One barber: the whole day is theirs, so bookings with no barber sit in the same column.
    columns = [{ key: `s-${solo.id}`, date: calendarDate, staffId: solo.id, name: solo.name, color: solo.color, appointments: onDay, blocked: blockedOnDay }];
  } else {
    columns = staffLookup.map((member) => ({
      key: `s-${member.id}`, date: calendarDate, staffId: member.id, name: member.name, color: member.color,
      appointments: onDay.filter((a) => a.staff_id === member.id),
      blocked: blockedOnDay.filter((b) => b.staff_id === member.id),
    }));
    const unassigned = onDay.filter((a) => !a.staff_id || !staffLookup.some((s) => s.id === a.staff_id));
    if (unassigned.length > 0 || columns.length === 0) {
      columns.push({ key: "none", date: calendarDate, staffId: null, name: "Unassigned", color: UNASSIGNED_COLOR, appointments: unassigned, blocked: [] });
    }
  }
  // One barber needs no name above the day. A lone "Unassigned" column still says so.
  const showNames = !manyDays && (columns.length > 1 || columns[0]?.staffId === null);
  const showHead = manyDays || showNames;
  const agenda = calendarView === "schedule" ? agendaDays(days, calendarAppointments, calendarBlocked) : [];

  const longDate = dateObj.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", year: "numeric" });
  const shownLabel = calendarView === "day" ? longDate : rangeLabel(days);
  const stepName = calendarView === "day" ? "day" : calendarView === "3day" ? "3 days" : "week";
  // Phones, week view: the week strip sits right above the day columns and names them.
  const stripIsHead = calendarView === "week" && monthShown === null;
  const monthOf = (date: string) => {
    const d = parseDate(date);
    const sameYear = d.getFullYear() === parseDate(todayStr).getFullYear();
    return d.toLocaleDateString("en-US", sameYear ? { month: "long" } : { month: "long", year: "numeric" });
  };

  const dayButton = (date: string, faded = false) => {
    const selected = date === calendarDate;
    const current = date === todayStr;
    return (
      <button
        key={date}
        type="button"
        aria-label={parseDate(date).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}
        aria-current={selected ? "date" : undefined}
        onClick={() => { chooseDate(date); setMonthShown(null); }}
        className="flex h-11 items-center justify-center focus-visible:outline-none"
      >
        <span className={cn(
          "flex h-9 w-9 items-center justify-center rounded-full text-base tabular-nums transition-colors",
          selected && current && "bg-primary font-semibold text-primary-foreground",
          selected && !current && "bg-foreground font-semibold text-background",
          !selected && current && "font-semibold text-primary",
          !selected && !current && faded && "text-muted-foreground/70",
        )}>{parseDate(date).getDate()}</span>
      </button>
    );
  };

  return (
    <div className="flex h-full min-w-0 flex-col md:gap-4 md:p-6">
      <p className="sr-only" aria-live="polite" aria-atomic="true">{shownLabel}</p>

      {/* Phones: the month, a jump to today, and a week to tap through. */}
      <div className="shrink-0 border-b border-border/70 md:hidden">
        <div className="flex items-center gap-1 px-2 pt-2">
          <h1 className="min-w-0 flex-1">
            <button
              type="button"
              aria-expanded={monthShown !== null}
              aria-controls="calendar-month"
              onClick={() => setMonthShown(monthShown === null ? shiftMonth(calendarDate, 0) : null)}
              className="flex h-11 items-center gap-1 rounded-full px-3 text-xl font-semibold tracking-tight active:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="truncate">{monthOf(monthShown ?? calendarDate)}</span>
              <ChevronDown className={cn("h-4 w-4 flex-shrink-0 text-muted-foreground transition-transform", monthShown !== null && "rotate-180")} aria-hidden="true" />
            </button>
          </h1>
          <button
            type="button"
            aria-label="Go to today"
            title="Today"
            onClick={() => { chooseDate(todayStr); setMonthShown(null); }}
            className="flex h-11 w-11 items-center justify-center rounded-full active:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="flex h-6 w-6 items-center justify-center rounded-md border-2 border-foreground text-[11px] font-semibold leading-none tabular-nums" aria-hidden="true">
              {parseDate(todayStr).getDate()}
            </span>
          </button>
          <div className="relative">
            <button
              type="button"
              aria-label={`Change view. Now showing ${CALENDAR_VIEWS.find((v) => v.key === calendarView)?.label ?? "Day"}`}
              title="Change view"
              aria-expanded={showViews}
              onClick={() => { setShowViews(!showViews); setShowMenu(false); }}
              className="flex h-11 w-11 items-center justify-center rounded-full active:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <ViewIcon className="h-5 w-5" aria-hidden="true" />
            </button>
            {showViews && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setShowViews(false)} aria-hidden="true" />
                <div role="menu" aria-label="Calendar view" className="absolute right-0 top-12 z-50 w-48 overflow-hidden rounded-2xl glass-thick py-1">
                  {CALENDAR_VIEWS.map((view) => {
                    const Icon = VIEW_ICONS[view.key];
                    const on = view.key === calendarView;
                    return (
                      <button key={view.key} type="button" role="menuitemradio" aria-checked={on} onClick={() => chooseView(view.key)} className="flex min-h-12 w-full items-center gap-3 px-4 text-left font-medium active:bg-muted">
                        <Icon className="h-4 w-4" aria-hidden="true" />
                        <span className="flex-1">{view.label}</span>
                        {on && <Check className="h-4 w-4 text-primary" aria-hidden="true" />}
                      </button>
                    );
                  })}
                </div>
              </>
            )}
          </div>
          <div className="relative">
            <button
              type="button"
              aria-label="More actions"
              aria-expanded={showMenu}
              onClick={() => { setShowMenu(!showMenu); setShowViews(false); }}
              className="flex h-11 w-11 items-center justify-center rounded-full active:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Ellipsis className="h-5 w-5" aria-hidden="true" />
            </button>
            {showMenu && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setShowMenu(false)} aria-hidden="true" />
                <div className="absolute right-0 top-12 z-50 w-48 overflow-hidden rounded-2xl glass-thick py-1">
                  <button type="button" onClick={toggleBlockForm} className="flex min-h-12 w-full items-center gap-3 px-4 text-left font-medium active:bg-muted">
                    <Ban className="h-4 w-4" aria-hidden="true" /> Block time
                  </button>
                  <button type="button" onClick={saveDaySheet} className="flex min-h-12 w-full items-center gap-3 px-4 text-left font-medium active:bg-muted">
                    <Download className="h-4 w-4" aria-hidden="true" /> Day sheet
                  </button>
                </div>
              </>
            )}
          </div>
        </div>

        <div id="calendar-month" className={cn("pb-1.5", stripIsHead ? "pl-14" : "px-2")}>
          <div className="grid grid-cols-7 text-center text-xs font-medium text-muted-foreground" aria-hidden="true">
            {DAY_LETTERS.map((letter, index) => <span key={index} className="py-1">{letter}</span>)}
          </div>
          {monthShown === null ? (
            <div
              className="grid grid-cols-7"
              onTouchStart={(e) => { const t = e.touches[0]; swipeFrom.current = t ? { x: t.clientX, y: t.clientY } : null; }}
              onTouchEnd={(e) => {
                const from = swipeFrom.current;
                swipeFrom.current = null;
                const to = e.changedTouches[0];
                if (from === null || to === undefined) return;
                const dx = to.clientX - from.x;
                // A mostly up-and-down drag is a scroll, not a swipe.
                if (Math.abs(dx) < 48 || Math.abs(to.clientY - from.y) > Math.abs(dx)) return;
                shiftDay(dx < 0 ? 7 : -7);
              }}
            >
              {weekOf(calendarDate).map((date) => dayButton(date))}
            </div>
          ) : (
            <>
              {monthGrid(monthShown).map((week) => (
                <div key={week[0]} className="grid grid-cols-7">
                  {week.map((date) => dayButton(date, date.slice(0, 7) !== monthShown.slice(0, 7)))}
                </div>
              ))}
              <div className="flex items-center justify-between pt-1">
                <button type="button" aria-label="Previous month" onClick={() => setMonthShown(shiftMonth(monthShown, -1))} className="flex h-11 w-11 items-center justify-center rounded-full active:bg-muted">
                  <ChevronLeft className="h-5 w-5" aria-hidden="true" />
                </button>
                <button type="button" aria-label="Next month" onClick={() => setMonthShown(shiftMonth(monthShown, 1))} className="flex h-11 w-11 items-center justify-center rounded-full active:bg-muted">
                  <ChevronRight className="h-5 w-5" aria-hidden="true" />
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Wide screens: a toolbar. */}
      <div className="hidden shrink-0 flex-wrap items-center justify-between gap-3 md:flex">
        <div className="flex items-center gap-3">
          <h1 className="text-[1.65rem] font-medium leading-tight tracking-tight">Calendar</h1>
          <Button variant="outline" size="sm" className="h-11" onClick={() => chooseDate(todayStr)}>Today</Button>
          <div role="group" aria-label="Calendar view" className="glass flex h-11 items-center rounded-full p-1">
            {CALENDAR_VIEWS.map((view) => (
              <button
                key={view.key}
                type="button"
                aria-pressed={view.key === calendarView}
                onClick={() => chooseView(view.key)}
                className={cn(
                  "h-full rounded-full px-3.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  view.key === calendarView ? "bg-card text-foreground shadow-chip" : "text-muted-foreground hover:text-foreground",
                )}
              >{view.label}</button>
            ))}
          </div>
        </div>
        <div className="flex min-w-0 items-center gap-2">
          <Button variant="outline" size="icon" className="h-11 w-11 shrink-0" aria-label={`Previous ${stepName}`} onClick={() => shiftDay(-step)}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="min-w-[200px] text-center text-sm font-semibold">{shownLabel}</span>
          <Button variant="outline" size="icon" className="h-11 w-11 shrink-0" aria-label={`Next ${stepName}`} onClick={() => shiftDay(step)}>
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" className="h-11" aria-expanded={showBlockForm} aria-controls="calendar-block-time" onClick={toggleBlockForm}>
            <Ban className="h-3.5 w-3.5" /> Block time
          </Button>
          <Button variant="outline" size="sm" className="h-11" onClick={saveDaySheet}>
            <Download className="h-3.5 w-3.5" /> Day sheet
          </Button>
          <Button size="sm" className="h-11" onClick={openBlankBooking}>
            <Plus className="h-3.5 w-3.5" /> New booking
          </Button>
        </div>
      </div>

      {showBlockForm && (
        <Card id="calendar-block-time" className="mx-3 my-3 shrink-0 md:m-0">
          <CardContent className="grid grid-cols-2 items-end gap-3 p-4 sm:grid-cols-4 xl:flex xl:flex-wrap">
            {calendarView !== "day" && <p className="col-span-2 text-sm font-medium sm:col-span-4 xl:basis-full">Block time on {longDate}</p>}
            {!solo && (
              <div className="col-span-2 min-w-0 space-y-1 xl:w-48">
                <Label htmlFor="block-staff" className="text-xs">Staff</Label>
                <select id="block-staff" className="h-11 w-full min-w-0 rounded-xl border border-input bg-card px-3 text-base md:text-sm" value={blockStaff} onChange={(e) => { setBlockStaff((e.target as HTMLSelectElement).value); clearBlockConflicts(); }}>
                  <option value="">Select staff...</option>
                  {staffLookup.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>
            )}
            <div className="min-w-0 space-y-1 xl:w-28">
              <Label htmlFor="block-start" className="text-xs">Start</Label>
              <Input id="block-start" type="time" className="h-11 w-full min-w-0" value={blockStart} onChange={(e) => { setBlockStart((e.target as HTMLInputElement).value); clearBlockConflicts(); }} />
            </div>
            <div className="min-w-0 space-y-1 xl:w-28">
              <Label htmlFor="block-end" className="text-xs">End</Label>
              <Input id="block-end" type="time" className="h-11 w-full min-w-0" value={blockEnd} onChange={(e) => { setBlockEnd((e.target as HTMLInputElement).value); clearBlockConflicts(); }} />
            </div>
            <div className="col-span-2 min-w-0 space-y-1 xl:flex-1">
              <Label htmlFor="block-reason" className="text-xs">Reason</Label>
              <Input id="block-reason" className="h-11" placeholder="e.g. Lunch break" value={blockReason} onChange={(e) => setBlockReason((e.target as HTMLInputElement).value)} />
            </div>
            {blockConflicts && (
              <div role="alert" className="col-span-2 flex min-w-0 gap-2.5 rounded-md border border-warning-border bg-warning-soft p-3 text-sm sm:col-span-4 xl:basis-full">
                <TriangleAlert className="mt-0.5 h-4 w-4 flex-shrink-0 text-warning" aria-hidden="true" />
                <div className="min-w-0 space-y-1">
                  <p className="font-medium">{solo ? "You are not free then." : `${staffLookup.find((s) => String(s.id) === blockStaff)?.name ?? "That staff member"} is not free then.`}</p>
                  <ul className="text-muted-foreground">
                    {blockConflicts.map((conflict, index) => <li key={index}>{describeConflict(conflict)}</li>)}
                  </ul>
                  <p className="text-muted-foreground">{solo ? "Choose another time, or block it anyway." : "Choose another time or staff member, or block it anyway."}</p>
                </div>
              </div>
            )}
            {blockConflicts && <Button type="button" variant="outline" size="sm" className="col-span-2 h-11 sm:col-span-1" onClick={() => handleAddBlock(true)}>Block anyway</Button>}
            <Button size="sm" className="col-span-2 h-11 sm:col-span-1" onClick={() => handleAddBlock()}>Add block</Button>
          </CardContent>
        </Card>
      )}

      {showCreate && (
        <CreateAppointment
          onClose={closeBooking}
          defaultDate={draftBooking?.date ?? calendarDate}
          defaultStaffId={draftBooking?.staffId}
          defaultStartTime={draftBooking?.startTime}
        />
      )}

      {calendarView === "schedule" ? (
      <div ref={scroller} className="min-h-0 min-w-0 flex-1 overflow-y-auto md:min-h-80 md:rounded-[1.25rem] md:border md:border-hairline md:bg-card md:shadow-soft" role="region" aria-label="Schedule" tabIndex={0}>
        {agenda.length === 0 ? (
          <p className="px-4 py-12 text-center text-muted-foreground">
            {isToday ? `No bookings in the next ${SCHEDULE_DAYS} days.` : `No bookings in these ${SCHEDULE_DAYS} days.`}
          </p>
        ) : (
          <ul className="pb-28 md:pb-3">
            {agenda.flatMap((day, index) => {
              const d = parseDate(day.date);
              const before = index > 0 ? agenda[index - 1].date.slice(0, 7) : null;
              const current = day.date === todayStr;
              const rows = [];
              if (before !== day.date.slice(0, 7)) {
                rows.push(<li key={`m-${day.date}`} className="px-4 pb-1 pt-4 text-sm font-semibold">{monthOf(day.date)}</li>);
              }
              rows.push(
                <li key={day.date} className="flex gap-2 px-2 py-2">
                  <button
                    type="button"
                    aria-label={`Open ${d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}`}
                    onClick={() => openDay(day.date)}
                    className="flex h-12 w-12 flex-shrink-0 flex-col items-center justify-center rounded-xl active:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <span className={cn("text-xs font-medium", current ? "text-primary" : "text-muted-foreground")}>{d.toLocaleDateString("en-US", { weekday: "short" })}</span>
                    <span className={cn("flex h-7 w-7 items-center justify-center rounded-full text-base tabular-nums", current && "bg-primary font-semibold text-primary-foreground")}>{d.getDate()}</span>
                  </button>
                  <ul className="min-w-0 flex-1 space-y-1.5">
                    {day.items.map((item) => {
                      if (item.kind === "block") {
                        return (
                          <li key={`b-${item.block.id}`} className="flex min-h-12 items-center gap-2 rounded-lg bg-muted py-1.5 pl-3 pr-1 text-muted-foreground">
                            <span className="flex min-w-0 flex-1 flex-col">
                              <span className="truncate text-sm font-medium">{item.block.reason || "Blocked"}</span>
                              <span className="text-xs">{formatRange(item.block.start_time, item.block.end_time)}</span>
                            </span>
                            <button
                              type="button"
                              aria-label={`Remove blocked time: ${item.block.reason || "Blocked"}`}
                              className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full hover:bg-press active:bg-press"
                              onClick={() => unblock(item.block)}
                            >
                              <X className="h-4 w-4" aria-hidden="true" />
                            </button>
                          </li>
                        );
                      }
                      const apt = item.booking;
                      const color = colorOf(apt.staff_id);
                      const services = apt.appointment_services?.map((s) => s.service_name).filter(Boolean).join(", ");
                      return (
                        <li key={`a-${apt.id}`}>
                          <button
                            type="button"
                            onClick={() => navigate(`/appointments/${apt.id}`)}
                            className="flex min-h-12 w-full flex-col justify-center rounded-lg px-3 py-1.5 text-left leading-tight focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
                            style={{ backgroundColor: color, color: inkOn(color) }}
                          >
                            <span className="truncate text-sm font-semibold">{apt.client_name}</span>
                            <span className="truncate text-xs opacity-90">{formatRange(apt.start_time, apt.end_time)}{services ? `, ${services}` : ""}</span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </li>,
              );
              return rows;
            })}
          </ul>
        )}
      </div>
      ) : (
      <div ref={scroller} className="flex min-h-0 min-w-0 flex-1 overflow-auto md:min-h-80 md:rounded-[1.25rem] md:border md:border-hairline md:bg-card md:shadow-soft" role="region" aria-label="Schedule" tabIndex={0}>
        {/* Hour labels. Each one sits on its line. */}
        <div className="sticky left-0 z-40 h-max min-h-full w-14 flex-shrink-0 bg-card/95 backdrop-blur-sm md:bg-card md:backdrop-blur-none">
          {showHead && <div className={cn("sticky top-0 z-10 bg-background", manyDays ? "h-14" : "h-9", stripIsHead && "hidden md:block")} />}
          <div className="h-3" />
          {HOURS.map((h) => (
            <div key={h} className="pr-2 text-right text-xs leading-none text-muted-foreground" style={{ height: hourHeight }}>
              <span className="relative -top-1.5">{formatHour(h)}</span>
            </div>
          ))}
        </div>

        <div className="flex h-max min-h-full flex-1">
          {columns.map((column, index) => (
            <div key={column.key} className={cn("flex flex-1 flex-col border-l border-border/70", manyDays ? "min-w-0 basis-0 md:min-w-[110px]" : "min-w-[9.5rem] md:min-w-[180px]")}>
              {manyDays && (
                <button
                  type="button"
                  aria-label={`Open ${column.name}`}
                  onClick={() => openDay(column.date)}
                  className={cn("sticky top-0 z-30 h-14 flex-shrink-0 flex-col items-center justify-center border-b bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring", stripIsHead ? "hidden md:flex" : "flex")}
                >
                  <span className={cn("text-xs font-medium", column.date === todayStr ? "text-primary" : "text-muted-foreground")}>{parseDate(column.date).toLocaleDateString("en-US", { weekday: "short" })}</span>
                  <span className={cn(
                    "flex h-7 w-7 items-center justify-center rounded-full text-sm tabular-nums",
                    column.date === todayStr && "bg-primary font-semibold text-primary-foreground",
                    column.date !== todayStr && column.date === calendarDate && "bg-foreground font-semibold text-background",
                  )}>{parseDate(column.date).getDate()}</span>
                </button>
              )}
              {showNames && (
                <div className="sticky top-0 z-30 flex h-9 flex-shrink-0 items-center justify-center gap-1.5 border-b bg-background px-2">
                  <span className="inline-block h-2.5 w-2.5 flex-shrink-0 rounded-full" style={{ backgroundColor: column.color }} aria-hidden="true" />
                  <span className={cn("truncate text-sm font-medium", column.staffId === null && "text-muted-foreground")}>{column.name}</span>
                </div>
              )}
              <div className="h-3 flex-shrink-0" />
              <div
                className="relative shrink-0 cursor-crosshair"
                style={{ height: totalHeight }}
                aria-label={`${column.name} schedule; click empty time to create a booking`}
                onClick={(event) => {
                  if ((event.target as HTMLElement).closest("[data-calendar-item]")) return;
                  openSlotBooking(column.staffId, column.date, event.currentTarget, event.clientY);
                }}
              >
                {HOURS.map((h) => (
                  <div key={h} className="absolute left-0 right-0 border-t border-border/70" style={{ top: topOf(h * 60) }} />
                ))}
                <div className="absolute left-0 right-0 border-t border-border/70" style={{ top: totalHeight }} />

                {nowInHours && column.date === todayStr && (
                  <div className="pointer-events-none absolute left-0 right-0 z-30 h-0.5 -translate-y-1/2 bg-danger" style={{ top: topOf(nowMinutes) }} aria-hidden="true">
                    {(manyDays || index === 0) && <span className="absolute left-0 -top-[5px] h-3 w-3 rounded-full bg-danger" />}
                  </div>
                )}

                {layOutColumn(column.appointments, column.blocked, dayStart).map((item) => {
                  const top = (item.start / totalMinutes) * totalHeight;
                  const height = ((item.end - item.start) / totalMinutes) * totalHeight;
                  const lane = laneStyle(item.lane, item.lanes, manyDays ? 1 : 4);

                  if (item.block) {
                    const block = item.block;
                    return (
                      <div
                        key={item.key}
                        data-calendar-item
                        title={block.reason || "Blocked"}
                        className={cn("absolute z-10 flex items-start justify-between gap-1 overflow-hidden rounded-lg bg-muted py-1 text-xs font-medium text-muted-foreground", manyDays ? "px-1" : "px-2")}
                        style={{
                          ...lane, top: top + 1, height: Math.max(height - 2, 22),
                          backgroundImage: "repeating-linear-gradient(135deg, transparent 0 6px, var(--press) 6px 7px)",
                        }}
                      >
                        <span className="truncate">{block.reason || "Blocked"}</span>
                        {!manyDays && (
                        <button
                          type="button"
                          aria-label={`Remove blocked time: ${block.reason || "Blocked"}`}
                          className="-mr-1 -mt-0.5 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full hover:bg-press active:bg-press"
                          onClick={(e) => { e.stopPropagation(); unblock(block); }}
                        >
                          <X className="h-3.5 w-3.5" aria-hidden="true" />
                        </button>
                        )}
                      </div>
                    );
                  }

                  const apt = item.appointment!;
                  const services = apt.appointment_services?.map((s) => s.service_name).filter(Boolean).join(", ");
                  const range = formatRange(apt.start_time, apt.end_time);
                  const price = `$${apt.total_price.toFixed(2)}`;
                  return (
                    <button
                      key={item.key}
                      type="button"
                      data-calendar-item
                      className={cn("absolute z-20 cursor-pointer overflow-hidden rounded-lg py-1 text-left leading-tight transition-shadow hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1", manyDays ? "px-1 md:px-2" : "px-2")}
                      style={{ ...lane, top: top + 1, height: Math.max(height - 2, 26), backgroundColor: colorOf(apt.staff_id), color: inkOn(colorOf(apt.staff_id)) }}
                      onClick={() => navigate(`/appointments/${apt.id}`)}
                      title={`${range} ${apt.client_name ?? ""}`}
                    >
                      {height < 44 ? (
                        <div className="truncate text-xs"><span className="font-semibold">{apt.client_name}</span> {range}</div>
                      ) : (
                        <>
                          <div className="truncate text-sm font-semibold">{apt.client_name}</div>
                          <div className="truncate text-xs opacity-90">{range}</div>
                          {services && height > 60 && <div className="truncate text-xs opacity-90">{services}</div>}
                          {height > 76 && <div className="text-xs font-medium opacity-90">{price}</div>}
                        </>
                      )}
                    </button>
                  );
                })}
              </div>
              <div className="h-24 flex-shrink-0 md:h-3" />
            </div>
          ))}
        </div>
      </div>
      )}

      {/* Phones: one round button to book. */}
      {!showCreate && (
        <button
          type="button"
          aria-label="New booking"
          title="New booking"
          onClick={openBlankBooking}
          className="fixed bottom-[calc(env(safe-area-inset-bottom)+5.5rem)] right-4 z-20 flex h-14 w-14 items-center justify-center rounded-full glass-tint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 md:hidden print:hidden"
        >
          <Plus className="h-6 w-6" aria-hidden="true" />
        </button>
      )}
      {sheet}
    </div>
  );
}
