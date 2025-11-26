import React, { useState, useEffect } from 'react';
import { Plus, Upload, Calendar, BookOpen, Save, X, FileText, Trash2 } from 'lucide-react';
import { useAuth } from '../../../../auth/AuthContext';
import { useSchoolClasses } from '../../../../hooks/useSchoolClasses';
import { useAcademicYear } from '../../../../contexts/AcademicYearContext';
import * as assignmentAPI from '../../../../api/assignment';
import { Assignment } from '../../types';
import api from '../../../../api/axios';

const AddAssignments: React.FC = () => {
  const { user, token } = useAuth();
  const { classesData, loading: classesLoading, getSectionsByClass } = useSchoolClasses();
  const { currentAcademicYear } = useAcademicYear();

  const [showAddForm, setShowAddForm] = useState(true); // Always show form by default
  const [availableSections, setAvailableSections] = useState<any[]>([]);
  const [availableSubjects, setAvailableSubjects] = useState<string[]>([]);
  const [loadingSubjects, setLoadingSubjects] = useState(false);
  const [saving, setSaving] = useState(false);
  const [newAssignment, setNewAssignment] = useState({
    title: '',
    description: '',
    subject: '',
    class: '',
    section: '',
    startDate: '',
    dueDate: '',
    attachments: [] as string[]
  });

  const classList = classesData?.classes?.map(c => c.className) || [];

  // Update sections when class changes
  useEffect(() => {
    if (newAssignment.class && classesData) {
      const sections = getSectionsByClass(newAssignment.class);
      setAvailableSections(sections);

      // Don't reset section and subject here - let them be reset only when needed
    } else {
      setAvailableSections([]);
      setNewAssignment(prev => ({
        ...prev,
        section: '',
        subject: ''
      }));
      setAvailableSubjects([]);
    }
  }, [newAssignment.class, classesData, getSectionsByClass]);

  // Fetch subjects when class and section are selected
  useEffect(() => {
    const fetchSubjects = async () => {
      if (!newAssignment.class || !newAssignment.section) {
        setAvailableSubjects([]);
        return;
      }

      setLoadingSubjects(true);
      try {
        let schoolCode = localStorage.getItem('erp.schoolCode') || user?.schoolCode || '';
        if (!schoolCode) {
          return;
        }

        // CRITICAL FIX: Convert schoolCode to UPPERCASE for consistent subject retrieval
        schoolCode = schoolCode.toUpperCase();

        // Primary API
        try {
          const response = await api.get('/class-subjects/classes', {
            headers: {
              'x-school-code': schoolCode
            }
          });
          const data = response.data;
          const classData = data?.data?.classes?.find((c: any) =>
            c.className === newAssignment.class && c.section === newAssignment.section
          );
          const activeSubjects = (classData?.subjects || []).filter((s: any) => s.isActive !== false);
          const subjectNames = activeSubjects.map((s: any) => s.name).filter(Boolean);
          setAvailableSubjects(subjectNames);
          return;
        } catch (_) {
          // Try fallback
        }

        // Fallback API
        try {
          const response2 = await api.get(`/direct-test/class-subjects/${newAssignment.class}`, {
            params: { schoolCode },
            headers: {
              'x-school-code': schoolCode
            }
          });
          const data2 = response2.data;
          const subjectNames = (data2?.data?.subjects || []).map((s: any) => s.name).filter(Boolean);
          setAvailableSubjects(subjectNames);
          return;
        } catch (_) {
          // ignore
        }

        setAvailableSubjects([]);
      } catch (err) {
        console.error('Error fetching subjects:', err);
        setAvailableSubjects([]);
      } finally {
        setLoadingSubjects(false);
      }
    }; fetchSubjects();
  }, [newAssignment.class, newAssignment.section, token, user?.schoolCode]);

  const handleAddAssignment = async () => {
    // Validate required fields
    if (!newAssignment.title || !newAssignment.description || !newAssignment.class ||
      !newAssignment.section || !newAssignment.subject || !newAssignment.startDate ||
      !newAssignment.dueDate) {
      alert('Please fill in all required fields');
      return;
    }

    // Validate due date is after start date
    if (new Date(newAssignment.dueDate) <= new Date(newAssignment.startDate)) {
      alert('Due date must be after start date');
      return;
    }

    setSaving(true);

    try {
      const formDataToSend = new FormData();

      // Add form fields
      formDataToSend.append('title', newAssignment.title);
      formDataToSend.append('subject', newAssignment.subject);
      formDataToSend.append('class', newAssignment.class);
      formDataToSend.append('section', newAssignment.section);
      formDataToSend.append('startDate', newAssignment.startDate);
      formDataToSend.append('dueDate', newAssignment.dueDate);
      formDataToSend.append('instructions', newAssignment.description);

      // Get school code from auth context
      const schoolCode = localStorage.getItem('erp.schoolCode') || user?.schoolCode || '';
      if (schoolCode) {
        formDataToSend.append('schoolCode', schoolCode);
        console.log('📤 Added schoolCode to request:', schoolCode);
      }

      // Add academic year
      if (currentAcademicYear) {
        formDataToSend.append('academicYear', currentAcademicYear);
        console.log('📤 Added academicYear to request:', currentAcademicYear);
      }

      console.log('📤 Creating assignment:', {
        title: newAssignment.title,
        subject: newAssignment.subject,
        class: newAssignment.class,
        section: newAssignment.section,
        startDate: newAssignment.startDate,
        dueDate: newAssignment.dueDate
      });

      const response = await assignmentAPI.createAssignmentWithFiles(formDataToSend);

      console.log('✅ Assignment created successfully:', response);
      alert(`Assignment created successfully for ${newAssignment.class} • Section ${newAssignment.section}`);

      // Reset form
      setNewAssignment({
        title: '',
        description: '',
        subject: '',
        class: '',
        section: '',
        startDate: '',
        dueDate: '',
        attachments: []
      });

    } catch (error: any) {
      console.error('❌ Error creating assignment:', error);
      alert(error.response?.data?.message || error.message || 'Failed to create assignment');
    } finally {
      setSaving(false);
    }
  };

  const handleFileUpload = (files: FileList | null) => {
    if (files) {
      const fileNames = Array.from(files).map(file => file.name);
      setNewAssignment(prev => ({
        ...prev,
        attachments: [...prev.attachments, ...fileNames]
      }));
    }
  };

  const removeAttachment = (index: number) => {
    setNewAssignment(prev => ({
      ...prev,
      attachments: prev.attachments.filter((_, i) => i !== index)
    }));
  };

  return (
    <div className="space-y-4 sm:space-y-6 p-4 sm:p-6">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold text-gray-900 mb-2">Add Assignments</h1>
          <p className="text-sm sm:text-base text-gray-600">Create and manage assignments for your students</p>
        </div>
      </div>

      {/* Add Assignment Form */}
      {showAddForm && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-4 sm:p-6">
          <div className="mb-4 sm:mb-6">
            <h2 className="text-base sm:text-lg font-semibold text-gray-900">Create New Assignment</h2>
          </div>

          <div className="space-y-4 sm:space-y-6">
            {/* Assignment Title */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Assignment Title *</label>
              <input
                type="text"
                value={newAssignment.title}
                onChange={(e) => setNewAssignment({ ...newAssignment, title: e.target.value })}
                placeholder="Enter assignment title"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
            </div>

            {/* Class, Section, Subject */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Class *</label>
                <select
                  value={newAssignment.class}
                  onChange={(e) => setNewAssignment({ ...newAssignment, class: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  disabled={classesLoading}
                >
                  <option value="">{classesLoading ? 'Loading...' : 'Select Class'}</option>
                  {classList.map((cls) => (
                    <option key={cls} value={cls}>Class {cls}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Section *</label>
                <select
                  value={newAssignment.section}
                  onChange={(e) => setNewAssignment({ ...newAssignment, section: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:bg-gray-100"
                  disabled={!newAssignment.class || availableSections.length === 0}
                >
                  <option value="">{!newAssignment.class ? 'Select Class First' : 'Select Section'}</option>
                  {availableSections.map((section) => (
                    <option key={section.value} value={section.value}>Section {section.section}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Subject *</label>
                <select
                  value={newAssignment.subject}
                  onChange={(e) => setNewAssignment({ ...newAssignment, subject: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:bg-gray-100"
                  disabled={!newAssignment.section || loadingSubjects}
                >
                  <option value="">
                    {!newAssignment.class ? 'Select Class First' :
                      !newAssignment.section ? 'Select Section First' :
                        loadingSubjects ? 'Loading subjects...' :
                          availableSubjects.length === 0 ? 'No subjects found' :
                            'Select Subject'}
                  </option>
                  {availableSubjects.map((subject) => (
                    <option key={subject} value={subject}>{subject}</option>
                  ))}
                </select>
              </div>
            </div>

            {/* Start Date and Due Date */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Start Date *</label>
                <input
                  type="date"
                  value={newAssignment.startDate}
                  onChange={(e) => setNewAssignment({ ...newAssignment, startDate: e.target.value })}
                  placeholder="dd-mm-yyyy"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Due Date *</label>
                <input
                  type="date"
                  value={newAssignment.dueDate}
                  onChange={(e) => setNewAssignment({ ...newAssignment, dueDate: e.target.value })}
                  placeholder="dd-mm-yyyy"
                  min={newAssignment.startDate || new Date().toISOString().split('T')[0]}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
              </div>
            </div>

            {/* Assignment Instructions */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2 text-center">Assignment Instructions *</label>
              <textarea
                value={newAssignment.description}
                onChange={(e) => setNewAssignment({ ...newAssignment, description: e.target.value })}
                rows={6}
                placeholder="Write detailed instructions for the assignment..."
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2 text-center">Attachments (Optional)</label>
              <div className="border border-gray-300 rounded-lg p-4">
                <input
                  type="file"
                  multiple
                  onChange={(e) => handleFileUpload(e.target.files)}
                  className="w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-medium file:bg-gray-100 file:text-gray-700 hover:file:bg-gray-200"
                />
              </div>

              {newAssignment.attachments.length > 0 && (
                <div className="mt-4 space-y-2">
                  {newAssignment.attachments.map((file, index) => (
                    <div key={index} className="flex items-center justify-between p-2 bg-gray-50 rounded-lg">
                      <div className="flex items-center">
                        <FileText className="h-4 w-4 text-gray-400 mr-2" />
                        <span className="text-sm text-gray-700">{file}</span>
                      </div>
                      <button
                        onClick={() => removeAttachment(index)}
                        className="p-1 text-red-600 hover:bg-red-50 rounded"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="flex justify-end space-x-3 pt-4">
              <button
                onClick={() => {
                  // Reset all form fields
                  setNewAssignment({
                    title: '',
                    description: '',
                    subject: '',
                    class: '',
                    section: '',
                    startDate: '',
                    dueDate: '',
                    attachments: []
                  });
                }}
                className="px-6 py-2 text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleAddAssignment}
                disabled={saving}
                className="flex items-center px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors disabled:bg-gray-400 disabled:cursor-not-allowed"
              >
                <Plus className="h-4 w-4 mr-2" />
                {saving ? 'Creating...' : 'Create Assignment'}
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
};

export default AddAssignments;