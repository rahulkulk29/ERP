import React, { useState, useEffect } from 'react';
import * as assignmentAPI from '../../../api/assignment';
import * as configAPI from '../../../api/config';
import CreateAssignmentModal from '../components/CreateAssignmentModal';
import EditAssignmentModal from '../components/EditAssignmentModal';
import { Plus, Search, Download, Calendar, Clock, FileText, Users, Edit, Trash2 } from 'lucide-react';
import { useSchoolClasses } from '../../../hooks/useSchoolClasses';
import { useAcademicYear } from '../../../contexts/AcademicYearContext';
import api from '../../../services/api';

interface Assignment {
  _id: string;
  title: string;
  subject: string;
  class: string;
  section?: string;
  teacher: string | { _id: string; name: string; firstName?: string; lastName?: string };
  dueDate: string;
  priority: 'high' | 'medium' | 'low';
  status: 'active' | 'completed' | 'overdue';
  submissions: number;
  totalStudents: number;
  description: string;
  academicYear?: string;
}

const Assignments: React.FC = () => {
  // Use the useSchoolClasses hook to fetch classes configured by superadmin
  const {
    classesData,
    loading: classesLoading,
    error: classesError,
    getClassOptions,
    getSectionsByClass
  } = useSchoolClasses();

  // Academic year context
  const { currentAcademicYear, viewingAcademicYear, isViewingHistoricalYear, setViewingYear, availableYears } = useAcademicYear();

  const [searchTerm, setSearchTerm] = useState('');
  const [selectedFilter, setSelectedFilter] = useState('all');
  const [selectedClass, setSelectedClass] = useState('');
  const [selectedSection, setSelectedSection] = useState('');
  const [selectedSubject, setSelectedSubject] = useState('');
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [selectedAssignmentId, setSelectedAssignmentId] = useState<string>('');
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [subjects, setSubjects] = useState<string[]>([]);
  const [stats, setStats] = useState({
    total: 0,
    active: 0,
    completed: 0,
    overdue: 0,
    dueThisWeek: 0
  });

  useEffect(() => {
    fetchAssignments();
  }, [viewingAcademicYear]);

  // Calculate stats whenever assignments change
  useEffect(() => {
    if (assignments.length > 0) {
      calculateStatsFromAssignments();
    }
  }, [assignments]);

  // Fetch subjects when class, section, or academic year changes
  useEffect(() => {
    if (selectedClass) {
      fetchSubjectsForClass(selectedClass);
    } else {
      setSubjects([]);
      setSelectedSubject('');
    }
  }, [selectedClass, selectedSection, viewingAcademicYear]);

  const fetchAssignments = async () => {
    try {
      setLoading(true);
      setError('');
      console.log('🔍 Fetching assignments for academic year:', viewingAcademicYear);

      let data;
      try {
        // Try the regular endpoint first with academic year parameter
        const response = await api.get('/assignments', {
          params: {
            academicYear: viewingAcademicYear
          }
        });
        data = response.data;
        console.log('✅ Assignments fetched from regular endpoint:', data);
      } catch (regularError) {
        console.error('❌ Error with regular endpoint:', regularError);

        // If the regular endpoint fails, try the direct endpoint
        console.log('🔍 Trying direct test endpoint...');

        // Get the user's school code from the auth context
        let userSchoolCode = '';
        try {
          const authData = localStorage.getItem('erp.auth');
          if (authData) {
            const parsedAuth = JSON.parse(authData);
            userSchoolCode = parsedAuth.user?.schoolCode || '';
            console.log(`🏫 Using school code from auth: "${userSchoolCode}"`);
          }
        } catch (err) {
          console.error('Error parsing auth data:', err);
        }

        // Try direct endpoint with the user's school code and academic year
        const params = new URLSearchParams({
          schoolCode: userSchoolCode,
          ...(viewingAcademicYear && { academicYear: viewingAcademicYear })
        });
        const response = await api.get(`/direct-test/assignments?${params.toString()}`);
        data = response.data;
        console.log('✅ Assignments fetched from direct endpoint:', data);
      }

      // Extract assignments array from response object
      const assignmentsArray = data.assignments || data || [];

      // Validate each assignment has required fields and filter out incomplete ones
      const validAssignments = assignmentsArray.filter((assignment: any) => {
        // Must be an object
        if (!assignment || typeof assignment !== 'object') return false;

        // Must have at least a title, class, and subject (not just default values)
        const hasTitle = assignment.title && assignment.title.trim() !== '';
        const hasClass = assignment.class && assignment.class.trim() !== '';
        const hasSubject = assignment.subject && assignment.subject.trim() !== '';

        return hasTitle && hasClass && hasSubject;
      });

      console.log(`✅ Processed ${validAssignments.length} valid assignments (filtered out ${assignmentsArray.length - validAssignments.length} incomplete)`);
      setAssignments(validAssignments);
    } catch (err: any) {
      console.error('❌ Error fetching assignments:', err);
      setError(err.response?.data?.message || err.message || 'Failed to fetch assignments');
      // Set empty array to prevent filtering errors
      setAssignments([]);
    } finally {
      setLoading(false);
    }
  };

  const fetchStats = async () => {
    try {
      // Try to fetch from assignment stats endpoint
      const response = await api.get('/assignment-stats');
      const data = response.data;
      setStats(data);
    } catch (err) {
      console.error('Error fetching stats:', err);
      // Fallback: calculate stats from assignments data
      calculateStatsFromAssignments();
    }
  };

  const calculateStatsFromAssignments = () => {
    if (!assignments || assignments.length === 0) {
      setStats({
        total: 0,
        active: 0,
        completed: 0,
        overdue: 0,
        dueThisWeek: 0
      });
      return;
    }

    const now = new Date();
    const weekFromNow = new Date();
    weekFromNow.setDate(weekFromNow.getDate() + 7);

    const calculatedStats = {
      total: assignments.length,
      active: 0,
      completed: 0,
      overdue: 0,
      dueThisWeek: 0
    };

    assignments.forEach(assignment => {
      const dueDate = new Date(assignment.dueDate);

      // Count by status
      if (assignment.status === 'active') calculatedStats.active++;
      if (assignment.status === 'completed') calculatedStats.completed++;
      if (assignment.status === 'overdue') calculatedStats.overdue++;

      // Count due this week
      if (dueDate >= now && dueDate <= weekFromNow) {
        calculatedStats.dueThisWeek++;
      }
    });

    setStats(calculatedStats);
  };

  const fetchSubjectsForClass = async (className: string) => {
    if (!className || !selectedSection) {
      setSubjects([]);
      setSelectedSubject('');
      return;
    }

    try {
      console.log(`🔍 Fetching subjects for class: ${className}, section: ${selectedSection}, academic year: ${viewingAcademicYear}`);

      let schoolCode = localStorage.getItem('erp.schoolCode') || '';
      if (!schoolCode) {
        console.error('❌ School code not available');
        setSubjects([]);
        return;
      }

      // CRITICAL FIX: Convert schoolCode to UPPERCASE for consistent subject retrieval
      schoolCode = schoolCode.toUpperCase();
      console.log('📚 Using school code (UPPERCASE):', schoolCode);

      // Primary API - using /class-subjects/classes to get all classes
      try {
        console.log('🔄 Trying primary API: /class-subjects/classes');
        const resp = await api.get('/class-subjects/classes', {
          headers: {
            'x-school-code': schoolCode
          }
        }); console.log('✅ Primary API response:', resp.data);

        if (resp.data?.success && resp.data?.data?.classes) {
          const classData = resp.data.data.classes.find((c: any) =>
            c.className === className && c.section === selectedSection
          );

          console.log('🎯 Found class data:', classData);

          if (classData?.subjects) {
            const activeSubjects = classData.subjects.filter((s: any) => s.isActive !== false);
            const subjectNames = activeSubjects.map((s: any) => s.name || s.subjectName).filter(Boolean);

            console.log('📝 Extracted subject names:', subjectNames);

            setSubjects(subjectNames);
            setSelectedSubject(subjectNames[0] || '');
            return;
          }
        }
      } catch (err) {
        console.error('❌ Primary API failed:', err);
        // fall through to fallback
      }

      // Fallback API
      try {
        console.log('🔄 Trying fallback API: /direct-test/class-subjects');
        const resp2 = await api.get(`/direct-test/class-subjects/${className}`, {
          params: { schoolCode },
          headers: {
            'x-school-code': schoolCode
          }
        });

        console.log('✅ Fallback API response:', resp2.data);

        if (resp2.data?.success && resp2.data?.data?.subjects) {
          const subjectNames = resp2.data.data.subjects
            .map((s: any) => s.name || s.subjectName)
            .filter(Boolean);

          console.log('📝 Extracted subject names from fallback:', subjectNames);

          setSubjects(subjectNames);
          setSelectedSubject(subjectNames[0] || '');
          return;
        }
      } catch (err) {
        console.error('❌ Fallback API failed:', err);
      }

      console.warn('⚠️ No subjects found for class/section');
      setSubjects([]);
      setSelectedSubject('');
    } catch (err) {
      console.error('❌ Error fetching subjects:', err);
      setSubjects([]);
      setSelectedSubject('');
    }
  };

  const handleAddAssignment = () => {
    setShowCreateModal(true);
  };

  const handleCreateSuccess = () => {
    fetchAssignments();
  };

  const handleEditAssignment = (assignmentId: string) => {
    console.log('✏️ Edit assignment:', assignmentId);
    setSelectedAssignmentId(assignmentId);
    setShowEditModal(true);
  };

  const handleEditSuccess = () => {
    fetchAssignments();
    setShowEditModal(false);
    setSelectedAssignmentId('');
  };

  const handleDeleteAssignment = async (assignmentId: string, assignmentTitle: string) => {
    const confirmed = window.confirm(
      `Are you sure you want to delete "${assignmentTitle}"?\n\nThis action cannot be undone.`
    );

    if (!confirmed) return;

    try {
      console.log('🗑️ Deleting assignment:', assignmentId);
      await assignmentAPI.deleteAssignment(assignmentId);

      console.log('✅ Assignment deleted successfully');

      // Show success message
      alert('Assignment deleted successfully!');

      // Refresh the assignments list
      fetchAssignments();
    } catch (error: any) {
      console.error('❌ Error deleting assignment:', error);
      alert(error.response?.data?.message || 'Failed to delete assignment');
    }
  };

  const getPriorityColor = (priority: string) => {
    switch (priority) {
      case 'high': return 'bg-red-100 text-red-800';
      case 'medium': return 'bg-yellow-100 text-yellow-800';
      case 'low': return 'bg-green-100 text-green-800';
      default: return 'bg-gray-100 text-gray-800';
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'active': return 'bg-blue-100 text-blue-800';
      case 'completed': return 'bg-green-100 text-green-800';
      case 'overdue': return 'bg-red-100 text-red-800';
      default: return 'bg-gray-100 text-gray-800';
    }
  };

  const filteredAssignments = assignments.filter(assignment => {
    // Add null checks to prevent "Cannot read properties of undefined" errors
    const title = assignment?.title || '';
    const subject = assignment?.subject || '';
    const status = assignment?.status || '';
    const assignmentClass = assignment?.class || '';

    const matchesSearch = title.toLowerCase().includes(searchTerm.toLowerCase()) ||
      subject.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesFilter = selectedFilter === 'all' || status === selectedFilter;
    const matchesClass = !selectedClass || assignmentClass === selectedClass;
    const matchesSubject = !selectedSubject || subject === selectedSubject;
    const matchesAcademicYear = !viewingAcademicYear || assignment.academicYear === viewingAcademicYear;

    // Note: Section filtering would require section data in assignment model

    return matchesSearch && matchesFilter && matchesClass && matchesSubject && matchesAcademicYear;
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold text-gray-900">Assignments</h1>
        <div className="flex space-x-3">
          <button className="bg-green-600 hover:bg-green-700 text-white px-4 py-2 rounded-lg flex items-center transition-colors">
            <Download className="h-4 w-4 mr-2" />
            Export Data
          </button>
          <button
            onClick={handleAddAssignment}
            className="bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 flex items-center gap-2"
          >
            <Plus className="h-4 w-4 mr-2" />
            Add Assignment
          </button>
        </div>
      </div>

      {/* Error Message */}
      {error && (
        <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded">
          {error}
        </div>
      )}

      {/* Loading State */}
      {loading && (
        <div className="text-center py-8">
          <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
          <p className="mt-2 text-gray-600">Loading assignments...</p>
        </div>
      )}

      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-200">
          <div className="flex items-center">
            <div className="bg-blue-500 p-3 rounded-lg">
              <FileText className="h-6 w-6 text-white" />
            </div>
            <div className="ml-4">
              <p className="text-sm font-medium text-gray-600">Total Assignments</p>
              <p className="text-2xl font-bold text-gray-900">{stats.total}</p>
            </div>
          </div>
        </div>
        <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-200">
          <div className="flex items-center">
            <div className="bg-purple-500 p-3 rounded-lg">
              <Calendar className="h-6 w-6 text-white" />
            </div>
            <div className="ml-4">
              <p className="text-sm font-medium text-gray-600">Due This Week</p>
              <p className="text-2xl font-bold text-gray-900">{stats.dueThisWeek}</p>
            </div>
          </div>
        </div>
      </div>

      {/* Search and Filters */}
      <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-200">
        <div className="flex flex-col md:flex-row gap-4">
          <div className="relative w-full md:w-64">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 h-5 w-5" />
            <input
              type="text"
              placeholder="Search assignments..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>
          <div className="flex flex-1 gap-3">
            <select
              value={viewingAcademicYear}
              onChange={(e) => setViewingYear(e.target.value)}
              className="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            >
              {availableYears.map((year) => (
                <option key={year} value={year}>
                  {year} {year === currentAcademicYear && '(Current)'}
                </option>
              ))}
            </select>
            <select
              value={selectedClass}
              onChange={(e) => setSelectedClass(e.target.value)}
              className="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            >
              <option value="">All Classes</option>
              {getClassOptions().map((cls) => (
                <option key={cls.value} value={cls.value}>{cls.label}</option>
              ))}
            </select>
            <select
              value={selectedSection}
              onChange={(e) => setSelectedSection(e.target.value)}
              className="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            >
              <option value="">All Sections</option>
              {(selectedClass ? getSectionsByClass(selectedClass) : []).map((section) => (
                <option key={section.value} value={section.value}>{section.label}</option>
              ))}
            </select>
            <select
              value={selectedSubject}
              onChange={(e) => setSelectedSubject(e.target.value)}
              className="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            >
              <option value="">All Subjects</option>
              {subjects.map((subject) => (
                <option key={subject} value={subject}>{subject}</option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* Assignments Table */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Assignment</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Class</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Section</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Subject</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Due Date</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Actions</th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {filteredAssignments.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-6 py-12 text-center">
                    <div className="flex flex-col items-center justify-center">
                      <FileText className="h-12 w-12 text-gray-400 mb-3" />
                      <p className="text-gray-500 text-lg font-medium">No assignments found</p>
                      <p className="text-gray-400 text-sm mt-1">
                        {searchTerm || selectedClass || selectedSection || selectedSubject || selectedFilter !== 'all'
                          ? 'Try adjusting your filters'
                          : 'Create your first assignment to get started'}
                      </p>
                    </div>
                  </td>
                </tr>
              ) : (
                filteredAssignments.map((assignment) => (
                  <tr key={assignment._id} className="hover:bg-gray-50">
                    <td className="px-6 py-4">
                      <div className="text-sm font-medium text-gray-900">{assignment.title || 'Untitled Assignment'}</div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                      {assignment.class || 'N/A'}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                      {assignment.section || 'N/A'}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                      {assignment.subject || 'N/A'}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                      <div className="flex items-center">
                        <Calendar className="h-4 w-4 mr-1 text-gray-400" />
                        {assignment.dueDate ? new Date(assignment.dueDate).toLocaleDateString() : 'No due date'}
                      </div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm font-medium">
                      <div className="flex space-x-2">
                        <button
                          onClick={() => handleEditAssignment(assignment._id)}
                          className="text-blue-600 hover:text-blue-900 p-1 rounded hover:bg-blue-50"
                          title="Edit assignment"
                        >
                          <Edit className="h-4 w-4" />
                        </button>
                        <button
                          onClick={() => handleDeleteAssignment(assignment._id, assignment.title)}
                          className="text-red-600 hover:text-red-900 p-1 rounded hover:bg-red-50"
                          title="Delete assignment"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Create Assignment Modal */}
      <CreateAssignmentModal
        isOpen={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        onSuccess={handleCreateSuccess}
      />

      {/* Edit Assignment Modal */}
      {selectedAssignmentId && (
        <EditAssignmentModal
          isOpen={showEditModal}
          onClose={() => {
            setShowEditModal(false);
            setSelectedAssignmentId('');
          }}
          onSuccess={handleEditSuccess}
          assignmentId={selectedAssignmentId}
        />
      )}
    </div>
  );
};

export default Assignments;