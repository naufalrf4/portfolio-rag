

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

const _d1: AboutData = {
  fullName: '',
  tagline: null,
  roles: [],
  shortBio: null,
  bio: '',
  email: '',
  location: null,
  avatarUrl: null,
  resumeUrl: null,
  availabilityStatus: null,
  skills: [],
  experience: [],
  socialLinks: [],
  updatedAt: '',
};

const _d2: ProjectListItem = {
  id: '',
  title: '',
  slug: '',
  summary: '',
  category: '',
  techStack: null,
  liveUrl: null,
  repoUrl: null,
  imageUrl: null,
  featured: false,
  createdAt: '',
  updatedAt: '',
  images: [],
};

const _d3: ProjectDetail = {
  id: '',
  title: '',
  slug: '',
  summary: '',
  description: '',
  content: null,
  category: '',
  techStack: null,
  liveUrl: null,
  repoUrl: null,
  imageUrl: null,
  featured: false,
  createdAt: '',
  updatedAt: '',
  projectDate: null,
  images: [],
};

const _d4: ProfileLink = {
  id: '',
  label: '',
  url: '',
  icon: null,
  visible: false,
  order: 0,
  createdAt: '',
  updatedAt: '',
};

const _d5: Blog = {
  id: '',
  url: '',
  title: '',
  description: null,
  imageUrl: null,
  source: '',
  category: null,
  publishedAt: '',
};

const _d6: Achievement = {
  id: '',
  name: '',
  location: '',
  monthYear: '',
  photos: [],
  description: '',
  externalUrl: null,
  order: 0,
  createdAt: '',
};

const _d7: GuestbookEntry = {
  id: '',
  message: '',
  createdAt: '',
  user: { name: null, image: null },
};

const _d8: GuestbookResponse = { entries: [] };

const _d9: MessageResponse = { success: false };

const _d10: ApiSuccessEnvelope<AboutData> = {
  success: true,
  data: _d1,
};

void _d1;
void _d2;
void _d3;
void _d4;
void _d5;
void _d6;
void _d7;
void _d8;
void _d9;
void _d10;
