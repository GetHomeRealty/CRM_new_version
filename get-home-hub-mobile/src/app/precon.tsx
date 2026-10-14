import { MobileScreen } from '@/components/mobile-screen';
import { RecordList } from '@/components/record-list';

const projects = [
  { title: 'Milton Village', detail: 'Milton · Detached & towns', meta: 'Updated', tone: 'success' as const },
  { title: 'Seaton Whitevale', detail: 'Pickering · Quick closings', meta: 'New', tone: 'primary' as const },
  { title: 'Lyric by Lynde Creek', detail: 'Whitby · Broker preview', meta: 'Event', tone: 'warning' as const },
];

export default function PreconScreen() {
  return (
    <MobileScreen eyebrow="Precon / Canada" title="Projects" subtitle="Inventory, pricing and project files">
      <RecordList items={projects} />
    </MobileScreen>
  );
}
