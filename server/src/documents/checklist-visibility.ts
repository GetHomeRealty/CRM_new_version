// Match the website DocsModal rules. Visibility never removes saved documents.
const listingTypes = ['Residential Sale Listing', 'Residential Lease Listing', 'Commercial Property Sale Listing', 'Commercial Property Lease Listing', 'Business Sale'];
export function checklistVisibility(type: string | null, statuses: string[]) {
 const listing = listingTypes.includes(type ?? '');
 const sale = listing && !/lease/i.test(type ?? '');
 const mutual = !listing && statuses.includes('Mutual Release');
 const restrict = !listing && statuses.includes('Void') ? ['agreement of purchase', 'aps', 'agreement to lease']
  : mutual ? ['agreement of purchase', 'aps', 'agreement to lease', 'mutual release', 'deposit receipt']
  : sale && statuses.includes('Active') ? ['listing agreement', 'mls data sheet', 'client photo', 'fintrac']
  : sale && statuses.includes('Terminated') ? ['listing agreement', 'mls data sheet', 'client photo', 'fintrac', 'cancellation'] : null;
 return (doc: { title: string | null }) => {
  const title = (doc.title ?? '').toLowerCase();
  return (mutual || !title.includes('mutual release')) && (!restrict || restrict.some(key => title.includes(key)));
 };
}
