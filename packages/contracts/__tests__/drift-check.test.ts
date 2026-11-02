

import { describe, it, expect } from 'bun:test';
import type {
  AboutData,
  ProjectListItem,
  ProjectDetail,
  ProfileLink,
  Blog,
  Achievement,
  GuestbookEntry,
  GuestbookResponse,
  MessageResponse,
  ApiSuccessEnvelope,
} from '@naufalrf/contracts';

type Availability = 'available' | 'busy' | 'unavailable' | null;

const aboutFixture = {
  fullName: 'Full Name',
  tagline: null as string | null,
  roles: [] as string[],
  shortBio: null as string | null,
  bio: '',
  email: 'email@example.com',
  location: null as string | null,
  avatarUrl: null as string | null,
  resumeUrl: null as string | null,
  availabilityStatus: null as Availability,
  skills: [{ name: 'TypeScript', level: 85, category: 'Language' }],
  experience: [
    {
      type: 'Work',
      title: 'Engineer',
      organization: 'Acme',
      location: null as string | null,
      startDate: '2020-01',
      endDate: null as string | null,
      description: '',
      logoUrl: null as string | null,
      skills: [] as string[],
    },
  ],
  socialLinks: [{ platform: 'github', url: 'https://github.com/naufalrf' }],
} satisfies AboutData;

const projectListItemFixture = {
  id: 'cuid-string',
  title: 'Project',
  slug: 'project',
  summary: 'A project',
  category: 'web',
  techStack: null as string[] | null,
  liveUrl: null as string | null,
  repoUrl: null as string | null,
  imageUrl: null as string | null,
  featured: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  images: [
    {
      id: 'img-id',
      url: 'https://example.com/img.jpg',
      order: 0,
      alt: null as string | null,
      caption: null as string | null,
    },
  ],
} satisfies ProjectListItem;

const projectDetailFixture = {
  id: 'cuid-string',
  title: 'Project',
  slug: 'project',
  summary: 'A project',
  description: 'Full description',
  content: null as string | null,
  category: 'web',
  techStack: null as string[] | null,
  liveUrl: null as string | null,
  repoUrl: null as string | null,
  imageUrl: null as string | null,
  featured: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  projectDate: null as string | null,
  images: [
    {
      id: 'img-id',
      projectId: 'cuid-string',
      url: 'https://example.com/img.jpg',
      key: null as string | null,
      order: 0,
      caption: null as string | null,
      alt: null as string | null,
      createdAt: '2026-01-01T00:00:00.000Z',
    },
  ],
} satisfies ProjectDetail;

const profileLinkFixture = {
  id: 'cuid-string',
  label: 'GitHub',
  url: 'https://github.com/naufalrf',
  icon: null as string | null,
  visible: true,
  order: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
} satisfies ProfileLink;

const blogFixture = {
  id: 'cuid-string',
  url: 'https://example.com/post',
  title: 'Blog Post',
  description: null as string | null,
  imageUrl: null as string | null,
  source: 'medium',
  category: null as string | null,
  publishedAt: '2026-01-01T00:00:00.000Z',
} satisfies Blog;

const achievementFixture = {
  id: 'cuid-string',
  name: 'Achievement Name',
  location: 'Jakarta',
  monthYear: '2026-01',
  photos: [] as string[],
  description: 'Achievement description',
  externalUrl: null as string | null,
  order: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
} satisfies Achievement;

const guestbookEntryFixture = {
  id: 'cuid-string',
  message: 'Hello!',
  createdAt: '2026-01-01T00:00:00.000Z',
  user: {
    name: null as string | null,
    image: null as string | null,
  },
} satisfies GuestbookEntry;

const guestbookResponseFixture = {
  entries: [guestbookEntryFixture],
} satisfies GuestbookResponse;

const messageResponseFixture = {
  success: false,
  error: { message: 'Failed to send message', code: 'TIMEOUT' },
} satisfies MessageResponse;

const envelopeFixture = {
  success: true as const,
  data: aboutFixture as AboutData,
  message: 'ok',
} satisfies ApiSuccessEnvelope<AboutData>;

describe('contract drift fixtures', () => {
  it('AboutData: fullName, skills, experience, socialLinks all present', () => {
    expect(aboutFixture.fullName).toBe('Full Name');
    expect(aboutFixture.skills).toHaveLength(1);
    expect(aboutFixture.experience).toHaveLength(1);
    expect(aboutFixture.socialLinks).toHaveLength(1);
    expect(aboutFixture.skills[0]!.name).toBe('TypeScript');
  });

  it('ProjectListItem: images are nested (not full ProjectImage)', () => {
    expect(projectListItemFixture.images).toHaveLength(1);
    expect(projectListItemFixture.images[0]!.url).toBe('https://example.com/img.jpg');
    expect((projectListItemFixture.images[0]! as Record<string, unknown>).projectId).toBeUndefined();
  });

  it('ProjectDetail: has description + content (list does not) + full images', () => {
    expect(projectDetailFixture.description).toBe('Full description');
    expect(projectDetailFixture.content).toBeNull();
    expect(projectDetailFixture.images[0]!.projectId).toBe('cuid-string');
    expect(projectDetailFixture.images[0]!.createdAt).toBeTruthy();
  });

  it('ProfileLink: has createdAt and updatedAt timestamps', () => {
    expect(profileLinkFixture.createdAt).toBeTruthy();
    expect(profileLinkFixture.updatedAt).toBeTruthy();
  });

  it('Blog: url and title are required, category nullable', () => {
    expect(blogFixture.url).toBeTruthy();
    expect(blogFixture.category).toBeNull();
  });

  it('Achievement: externalUrl is nullable', () => {
    expect(achievementFixture.externalUrl).toBeNull();
    expect(achievementFixture.photos).toEqual([]);
  });

  it('Guestbook: wraps entries with user sub-object', () => {
    expect(guestbookResponseFixture.entries).toHaveLength(1);
    expect(guestbookResponseFixture.entries[0]!.user.name).toBeNull();
  });

  it('MessageResponse: success flag + optional error', () => {
    expect(messageResponseFixture.success).toBe(false);
    expect(messageResponseFixture.error!.message).toBeTruthy();
  });

  it('ApiSuccessEnvelope: wraps generic data', () => {
    expect(envelopeFixture.success).toBe(true);
    expect(envelopeFixture.data.fullName).toBe('Full Name');
  });
});
