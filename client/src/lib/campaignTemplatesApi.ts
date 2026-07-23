import api from './axios';
import type {
  CampaignTemplateAttachment, CampaignTemplateDetail, CampaignTemplateInput,
} from '../types';

/** Campaign template library. Separate from Email Settings' transactional templates. */

export const listCampaignTemplates = (category = ''): Promise<CampaignTemplateDetail[]> =>
  api.get<CampaignTemplateDetail[]>('/api/campaigns/templates', {
    params: category && category !== 'all' ? { category } : {},
  }).then((r) => r.data);

export const getCampaignTemplate = (id: number): Promise<CampaignTemplateDetail> =>
  api.get<CampaignTemplateDetail>(`/api/campaigns/templates/${id}`).then((r) => r.data);

export const createCampaignTemplate = (body: CampaignTemplateInput): Promise<CampaignTemplateDetail> =>
  api.post<CampaignTemplateDetail>('/api/campaigns/templates', body).then((r) => r.data);

export const updateCampaignTemplate = (id: number, body: Partial<CampaignTemplateInput>): Promise<CampaignTemplateDetail> =>
  api.put<CampaignTemplateDetail>(`/api/campaigns/templates/${id}`, body).then((r) => r.data);

export const deleteCampaignTemplate = (id: number): Promise<{ deleted: boolean; used_by: number }> =>
  api.delete<{ deleted: boolean; used_by: number }>(`/api/campaigns/templates/${id}`).then((r) => r.data);

/** Upload a file. `data` is base64 (a `data:` URI prefix is accepted and stripped). */
export const addTemplateAttachment = (
  id: number,
  file: { filename: string; content_type: string; data: string },
): Promise<CampaignTemplateAttachment> =>
  api.post<CampaignTemplateAttachment>(`/api/campaigns/templates/${id}/attachments`, file).then((r) => r.data);

export const deleteTemplateAttachment = (id: number, attachmentId: number): Promise<void> =>
  api.delete(`/api/campaigns/templates/${id}/attachments/${attachmentId}`).then(() => undefined);

export const templateAttachmentUrl = (id: number, attachmentId: number): string =>
  `${api.defaults.baseURL ?? ''}/api/campaigns/templates/${id}/attachments/${attachmentId}`;
